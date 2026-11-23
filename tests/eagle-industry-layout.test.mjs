import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {locateEagleProductFolder,inspectIndustryTree,industryFolderName} from '../scripts/eagle-folder-layout.mjs';
import {ensureEagleProductFolders} from '../scripts/eagle-archive.mjs';
import {planIndustryMoves,moveIndustryProduct,rollbackIndustryProduct,
  assertIndustryMigrationNotActive,migrationGuardPath} from '../scripts/eagle-industry-move.mjs';
import {classifyManual} from '../scripts/industry-core.mjs';
import {updateProductClassification,readRegistry} from '../scripts/capture-store.mjs';
const id='947780804552';
const prod=()=>({id:'PRODUCT-01',name:id,children:[
  {id:'MAIN-01',name:'主图',children:[]},{id:'DETAIL-01',name:'详情页',children:[]}
]});
const rootWith=(...children)=>[{id:'ROOT-01',name:'电商平台批量采集',children}];
const nest=code=>({id:'IND-'+code,name:industryFolderName(code),children:[prod()]});
const registry={products:{[id]:{productId:id,classification:classifyManual('adult','female')}}};
test('Canonical folder resolver reads a legacy product and exposes its stable child IDs',()=>{
  const x=locateEagleProductFolder(rootWith(prod()),id);
  assert.equal(x.parentId,'ROOT-01');
  assert.equal(x.productFolderId,'PRODUCT-01');
  assert.equal(x.mainFolderId,'MAIN-01');
  assert.equal(x.industryCode,null);
});
test('Canonical resolver reads an industry-nested folder without moving child folders',()=>{
  const x=locateEagleProductFolder(rootWith(nest('adult')),id);
  assert.equal(x.parentId,'IND-adult');
  assert.equal(x.industryCode,'adult');
  assert.equal(x.detailFolderId,'DETAIL-01');
  assert.equal(inspectIndustryTree(rootWith(nest('adult'))).products.length,1);
});
test('Duplicate ID under two folders fails closed, never creates another folder',()=>{
  assert.throws(()=>locateEagleProductFolder(rootWith(prod(),nest('adult')),id),/Ambiguous/);
  assert.throws(()=>inspectIndustryTree(rootWith(prod(),nest('adult'))),/Duplicate/);
});
test('Unknown industry folder or incompatible nesting fails closed',()=>{
  assert.throws(()=>inspectIndustryTree(rootWith({id:'UNOWNED',name:'用户其它目录',children:[]})),/Unknown/);
  assert.throws(()=>locateEagleProductFolder(rootWith({id:'UNOWNED',name:'陌生行业',children:[prod()]}),id),/unknown/);
});
test('Migration planner chooses existing industry ID and skips a correctly nested product',()=>{
  const old=planIndustryMoves(rootWith(prod()),registry);
  assert.equal(old.toMove,1);
  assert.equal(old.tasks[0].targetIndustryName,'成人用品');
  const next=planIndustryMoves(rootWith(nest('adult')),registry);
  assert.equal(next.toMove,0);assert.equal(next.alreadyCorrect,1);
});
test('New-product folder creation always adds the industry level, not a root-level product',async()=>{
  const roots=rootWith();let serial=1;
  const rpc=async(name,args)=>{
    if(name==='folder_get')return structuredClone(roots);
    if(name==='folder_create'){
      const spec=args.folders[0],node={id:'NEW-'+serial++,name:spec.name,children:[]};
      const walk=xs=>{for(const x of xs){if(x.id===spec.parentId){x.children.push(node);return true;}if(walk(x.children||[]))return true;}return false};
      if(!walk(roots))throw Error('Missing test parent');
      return {id:node.id};
    }
    throw Error('Unexpected call '+name);
  };
  const x=await ensureEagleProductFolders({rpc,productId:id,industryCode:'adult'});
  assert.equal(x.industryCode,'adult');
  assert.equal(roots[0].children[0].name,'成人用品');
  assert.equal(roots[0].children[0].children[0].name,id);
  assert.equal(roots[0].children[0].children[0].children.length,2);
  const again=await ensureEagleProductFolders({rpc,productId:id,industryCode:'adult'});
  assert.equal(again.product,x.product);
});
test('An old direct folder is reused before any new industry folder is created',async()=>{
  const roots=rootWith(prod());let writes=0;
  const rpc=async(name)=>{if(name==='folder_get')return structuredClone(roots);
    if(name==='folder_create'){writes++;throw Error('MUST_NOT_CREATE');}
    throw Error('Unexpected '+name)};
  const x=await ensureEagleProductFolders({rpc,productId:id,industryCode:'adult'});
  assert.equal(x.product,'PRODUCT-01');assert.equal(writes,0);
});
function mockProject(){
  const root=mkdtempSync(join(tmpdir(),'industry-move-test-'));
  mkdirSync(join(root,'config'));mkdirSync(join(root,'data'));
  writeFileSync(join(root,'config','local.json'),JSON.stringify({eagleMcpUrl:'http://example.test/mcp'}));
  writeFileSync(join(root,'data','captures.json'),JSON.stringify({schemaVersion:1,...registry}));
  const tree=rootWith(prod());
  const items={'PRODUCT-01':['LONG-001'],'MAIN-01':['M-001','M-002'],
    'DETAIL-01':['D-001','D-002','D-003']};
  let updates=0,creates=0;
  const find=(node,id)=>{for(const x of node){if(x.id===id)return x;const nested=find(x.children||[],id);if(nested)return nested;}return null};
  const rpc=async(name,args={})=>{
    if(name==='folder_get')return structuredClone(tree);
    if(name==='get_app_info')return{libraryPath:'C:/unit-test-industry-lib'};
    if(name==='item_get')return(items[args.folders?.[0]]||[]).map(id=>({id}));
    if(name==='folder_create'){
      creates++;const spec=args.folders[0];
      find(tree,spec.parentId).children.push({id:spec.name==='成人用品'?'IND-adult':'IND-electronics',name:spec.name,children:[]});
      return {success:true};
    }
    if(name==='folder_update'){
      updates++;const spec=args.folders[0];
      const remove=(xs,id)=>{for(let i=0;i<xs.length;i++){
        if(xs[i].id===id)return xs.splice(i,1)[0];
        const found=remove(xs[i].children||[],id);if(found)return found;
      }return null};
      const node=remove(tree,spec.id);find(tree,spec.parentId).children.push(node);
      return{success:true};
    }
    throw Error('Unexpected mock RPC '+name);
  };
  return{root,tree,items,rpc,get writes(){return{updates,creates}},dispose:()=>rmSync(root,{force:true,recursive:true})};
}
test('Manual industry change re-parents same product folder without changing item IDs',async()=>{
  const m=mockProject();
  try{
    await moveIndustryProduct(m.root,id,{rpc:m.rpc});
    await updateProductClassification(m.root,id,classifyManual('electronics','powerbank'));
    const recorded=readRegistry(m.root).products[id].classification;
    assert.equal(recorded.industryCode,'electronics');
    const planned=planIndustryMoves(m.tree,readRegistry(m.root),{productId:id});
    assert.equal(planned.tasks[0].targetIndustryName,'3C数码');
    const next=await moveIndustryProduct(m.root,id,{rpc:m.rpc});
    assert.equal(next.status,'moved');
    assert.equal(locateEagleProductFolder(m.tree,id).industryName,'3C数码');
    assert.equal(locateEagleProductFolder(m.tree,id).mainFolderId,'MAIN-01');
    assert.deepEqual(m.writes,{creates:2,updates:2});
  }finally{m.dispose()}
});
test('A verified snapshot supports an explicit read-only rollback plan and controlled restore',async()=>{
  const m=mockProject();
  try{
    await moveIndustryProduct(m.root,id,{rpc:m.rpc});
    const preview=await rollbackIndustryProduct(m.root,id,{rpc:m.rpc,mode:'check'});
    assert.equal(preview.status,'rollback_ready');assert.equal(preview.eagleWrites,0);
    assert.equal(m.writes.updates,1);
    const rolled=await rollbackIndustryProduct(m.root,id,{rpc:m.rpc,mode:'apply'});
    assert.equal(rolled.status,'rolled_back');assert.equal(rolled.verifiedPreserved,true);
    assert.equal(locateEagleProductFolder(m.tree,id).parentId,'ROOT-01');
    assert.equal(m.writes.updates,2);
  }finally{m.dispose()}
});
test('Guard rejects concurrent capture while folder migration is active',()=>{
  const m=mockProject();
  try{
    mkdirSync(migrationGuardPath(m.root),{recursive:true});
    assert.throws(()=>assertIndustryMigrationNotActive(m.root),/currently active/);
  }finally{m.dispose()}
});
test('Folder move uses one parentId update, preserving ID and all linked images',async()=>{
  const m=mockProject();
  try{
    const result=await moveIndustryProduct(m.root,id,{rpc:m.rpc});
    assert.equal(result.status,'moved');assert.equal(result.verifiedPreserved,true);
    assert.deepEqual(m.writes,{updates:1,creates:1});
    const nested=locateEagleProductFolder(m.tree,id);
    assert.equal(nested.parentId,'IND-adult');
    assert.equal(nested.productFolderId,'PRODUCT-01');
    const history=readdirSync(join(m.root,'data','migrations','industry'))
      .filter(name=>name.startsWith(id)&&name.endsWith('.json'));
    assert.equal(history.length,1);
    const proof=JSON.parse(readFileSync(join(m.root,'data','migrations','industry',history[0])));
    assert.equal(proof.status,'complete');
    assert.equal(proof.baseline.items.root[0],'LONG-001');
    assert.equal(proof.baseline.items.detail.length,3);
    const second=await moveIndustryProduct(m.root,id,{rpc:m.rpc});
    assert.equal(second.status,'already_correct');
    assert.equal(m.writes.updates,1);
  }finally{m.dispose()}
});
