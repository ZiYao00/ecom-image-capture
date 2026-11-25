import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {classifyManual} from '../scripts/industry-core.mjs';
import {smartFolderSpecs,findOwnedSmartFolder,planIndustryTags,
  eagleWebAPI,eagleSmartFolderRules,listSmartFolders,
  tagIndustryRepresentative,syncIndustryEagle} from '../scripts/industry-eagle.mjs';

test('Eagle industry view rules filter only the managed product tags',()=>{
  const x=smartFolderSpecs(classifyManual('electronics','powerbank'));
  assert.equal(x.top.name,'采集行业｜3C数码');
  assert.equal(x.child.name,'充电宝');
  assert.deepEqual(x.top.conditions[0].rules[0],{
    property:'tags',method:'union',value:['采集行业｜3C数码']});
  assert.equal(x.child.conditions[0].rules.length,2);
  assert.equal(x.tags.length,2);
});
test('Existing unrelated or duplicate smart folders must never be overwritten',()=>{
  const spec=smartFolderSpecs(classifyManual('adult','female')).top;
  assert.throws(()=>findOwnedSmartFolder([{name:spec.name,description:'user',_parent:null}],spec),/another owner/);
  assert.throws(()=>findOwnedSmartFolder([
    {...spec,id:'A',_parent:null},{...spec,id:'B',_parent:null}
  ],spec),/Duplicate/);
});
test('Smart folder GET tree is flattened with correct hierarchical identity',async()=>{
  const classification=classifyManual('apparel','chestpad');
  const {top,child}=smartFolderSpecs(classification);
  const all=await listSmartFolders({api:async()=>({data:[
    {...top,id:'TOP12345',children:[{...child,id:'SUB12345'}]}
  ]})});
  assert.equal(all.length,2);
  assert.equal(findOwnedSmartFolder(all,child,'TOP12345')?.id,'SUB12345');
});
test('Project tags are removed selectively without touching unrelated user tags',()=>{
  assert.deepEqual(planIndustryTags(['原创','采集行业｜成人用品','采集子类｜成人用品／女用器具'],
    ['采集行业｜3C数码','采集子类｜3C数码／充电宝']),{
      add:['采集行业｜3C数码','采集子类｜3C数码／充电宝'],
      remove:['采集行业｜成人用品','采集子类｜成人用品／女用器具']
    });
});
test('Eagle smartfolder capability schema is checked before creation',async()=>{
  await assert.rejects(()=>eagleSmartFolderRules({api:async()=>({tags:{methods:['equal'],valueType:'string_array'}})}),/do not support/);
  const x=await eagleSmartFolderRules({api:async()=>({tags:{methods:['union'],valueType:'string_array'}})});
  assert.equal(x.tags.valueType,'string_array');
});
test('Eagle API route guard allows query but rejects outside routes',async()=>{
  let called;
  const r=await eagleWebAPI('/item/get?id=TEST123456',{fetchFn:async url=>{
    called=url;return{ok:true,json:async()=>({status:'success',data:{data:[]}})};
  }});
  assert.deepEqual(r,{data:[]});
  assert.match(called,/\/api\/v2\/item\/get\?id=TEST123456/);
  await assert.rejects(()=>eagleWebAPI('/app/delete',{fetchFn:async()=>null}),/Unsupported industry API path/);
  await assert.rejects(()=>eagleWebAPI('http://evil.test/item/get',{fetchFn:async()=>null}),/Unsupported industry API path/);
});
test('Manual reclassification removes only previous managed tags, preserving unrelated tags',async()=>{
  const chosen=classifyManual('apparel','chestpad');
  let tags=['收藏','采集行业｜3C数码','采集子类｜3C数码／充电宝'];
  const operations=[];
  const api=async route=>{
    if(route.startsWith('/item/get?'))return{data:[{id:'MANUAL123456',name:'long',tags:[...tags]}]};
    throw Error('Unexpected API: '+route);
  };
  const rpc=async(name,args)=>{
    operations.push(name);
    if(name==='item_add_tags')tags=[...new Set([...tags,...args.tags])];
    if(name==='item_remove_tags')tags=tags.filter(x=>!args.tags.includes(x));
  };
  const result=await tagIndustryRepresentative('MANUAL123456',chosen,{rpc,api});
  assert.equal(result.status,'verified');
  assert.deepEqual(operations,['item_add_tags','item_remove_tags']);
  assert.deepEqual(tags.sort(),['收藏','采集行业｜服饰内衣','采集子类｜服饰内衣／胸贴'].sort());
});
test('Eagle item tags are applied by incremental API and verified without replacing user tags',async()=>{
  const classification=classifyManual('electronics','powerbank');
  let tags=['收藏'],writes=[];
  const api=async(route)=>{
    if(route.startsWith('/item/get?'))return{data:[{id:'ITEM12345678',tags,name:'long'}]};
    throw Error('Unexpected API '+route);
  };
  const rpc=async(name,args)=>{
    writes.push([name,args]);
    if(name==='item_add_tags')tags=[...tags,...args.tags];
    else if(name==='item_remove_tags')tags=tags.filter(x=>!args.tags.includes(x));
  };
  const x=await tagIndustryRepresentative('ITEM12345678',classification,{rpc,api});
  assert.equal(x.status,'verified');
  assert.equal(writes.length,1);
  assert.equal(writes[0][0],'item_add_tags');
  assert.equal(tags.includes('收藏'),true);
  assert.equal(x.preservedUnmanagedTags,true);
});

test('Retired industry smart folder routes reject all writes before network access',async()=>{
  const fetchFn=async()=>{assert.fail('Unexpected smart folder network call')};
  for(const method of ['GET','POST','DELETE']){
    await assert.rejects(()=>eagleWebAPI('/smartFolder/create',{method,fetchFn}),/retired/);
  }
  await assert.rejects(()=>eagleWebAPI('/smartFolder/get',{method:'POST',fetchFn}),/retired/);
});
test('Complete industry synchronization requires no smart folders, preserves user tags and is idempotent',async t=>{
  const root=mkdtempSync(join(tmpdir(),'ecom-industry-tags-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const productId='123456789012',itemId='TESTLONG123456',name='Tmall-'+productId+'-detail-long-750w';
  const classification=classifyManual('electronics','powerbank');
  mkdirSync(join(root,'data'));mkdirSync(join(root,'config'));
  writeFileSync(join(root,'data','captures.json'),JSON.stringify({schemaVersion:1,products:{
    [productId]:{productId,workflowStatus:'complete',classification}
  }}));
  writeFileSync(join(root,'config','local.json'),'{}');
  let tags=['收藏','采集行业｜成人用品','采集子类｜成人用品／女用器具'];
  const reads=[],writes=[];
  const api=async route=>{
    reads.push(route);
    assert.equal(route,'/item/get?id='+itemId);
    return {data:[{id:itemId,name,tags:[...tags],folders:['REALPRODUCTFOLDER']}]};
  };
  const rpc=async(method,args)=>{
    if(method==='get_app_info')return {libraryPath:join(root,'mock-library')};
    writes.push(method);
    if(method==='item_add_tags')tags=[...new Set([...tags,...args.tags])];
    else if(method==='item_remove_tags')tags=tags.filter(x=>!args.tags.includes(x));
    else assert.fail('Unexpected Eagle write: '+method);
  };
  const opts={api,rpc,verifyRepresentative:()=>({itemId,name,sha256:'a'.repeat(64)})};
  for(let i=0;i<2;i++){
    const result=await syncIndustryEagle(root,productId,opts);
    assert.equal(result.status,'synced');
    assert.equal(result.smartFolders,'retired');
    assert.deepEqual(result.smartFolderIds,[]);
    assert.equal(result.verified,true);
  }
  assert.deepEqual(writes,['item_add_tags','item_remove_tags']);
  assert.ok(reads.length>0);
  assert.deepEqual(tags.sort(),['收藏','采集行业｜3C数码','采集子类｜3C数码／充电宝'].sort());
  const events=readFileSync(join(root,'data','industry-sync',productId+'.events.jsonl'),'utf8')
    .trim().split('\n').map(x=>JSON.parse(x));
  assert.equal(events.filter(x=>x.event==='industry_tags_verified').length,2);
  assert.ok(events.every(x=>!x.event.startsWith('smart_folder')));
});
