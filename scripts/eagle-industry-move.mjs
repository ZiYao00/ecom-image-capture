// Safe PC-local move of an EXISTING Eagle product folder to one extra industry level.
// Never item_add, never delete, never move the product's images or its child folders.
import {existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync,renameSync,statSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readRegistry} from './capture-store.mjs';
import {acquireLibraryLock} from './v3-job-state.mjs';
import {eagleArchiveRpc,ECOM_ARCHIVE_ROOT} from './eagle-archive.mjs';
import {listFolderItems} from './eagle-current.mjs';
import {inspectIndustryTree,industryFolderName,productFolderName} from './eagle-folder-layout.mjs';

export const migrationGuardPath=root=>join(root,'data','locks','industry-layout.lock');
export function assertIndustryMigrationNotActive(root){
  if(existsSync(migrationGuardPath(root)))
    throw Error('Eagle industry-layout migration currently active; do not start capture/restore');
}
function guard(root){
  const dir=migrationGuardPath(root);
  mkdirSync(dirname(dir),{recursive:true});
  if(existsSync(dir))throw Error('Industry migration guard already exists; inspect owner before recovery');
  const productLocks=readdirSync(dirname(dir)).filter(n=>/^product-\d{8,16}\.lock$/.test(n));
  if(productLocks.length)throw Error('Active/unknown product locks prevent folder migration: '+productLocks.join(','));
  mkdirSync(dir);
  const token=randomUUID();
  writeFileSync(join(dir,'owner.json'),JSON.stringify({pid:process.pid,token,at:new Date().toISOString()})+'\n',{flag:'wx'});
  return()=>{
    const owner=JSON.parse(readFileSync(join(dir,'owner.json'),'utf8'));
    if(owner.token!==token)throw Error('Industry migration guard ownership changed');
    // Archive the only owned guard atomically rather than deleting an uncertain lock.
    const history=join(root,'data','migrations','industry','guard-history');
    mkdirSync(history,{recursive:true});
    renameSync(dir,join(history,'guard-'+token));
  };
}
const asItems=x=>Array.isArray(x)?x:Array.isArray(x?.items)?x.items:[];
async function categoryItems(rpc,id){
  const items=await listFolderItems(rpc,id);
  if(items.some(x=>!x?.id))throw Error('Malformed Eagle folder-item readback');
  const ids=items.map(x=>x.id);
  if(new Set(ids).size!==ids.length)throw Error('Duplicate Eagle item ID in folder '+id);
  return ids.sort();
}
async function baselineOf(rpc,product){
  const folderIds={product:product.folderId,main:product.mainFolderId,detail:product.detailFolderId};
  const [root,main,detail]=await Promise.all([
    categoryItems(rpc,folderIds.product),
    categoryItems(rpc,folderIds.main),
    categoryItems(rpc,folderIds.detail)
  ]);
  return {folderIds,items:{root,main,detail}};
}
export function planIndustryMoves(tree,registry,{productId=null}={}){
  const snapshot=inspectIndustryTree(tree);
  const products=registry?.products||{};
  if(productId&&!productFolderName(productId))throw Error('Invalid product ID');
  const tasks=snapshot.products.filter(x=>!productId||x.productId===productId).map(x=>{
    const entry=products[x.productId];
    if(!entry||!entry.classification)
      throw Error('Registered product classification missing for folder '+x.productId);
    const code=entry.classification.status==='needs_review'?null:entry.classification.industryCode;
    const expected=industryFolderName(code);
    const target=snapshot.industries.find(item=>item.name===expected)||null;
    return {...x,targetIndustryCode:code,targetIndustryName:expected,
      targetParentId:target?.id||null,
      state:x.industryName===expected?'already_correct':'needs_move'};
  });
  if(productId&&tasks.length!==1)throw Error('Product folder not found uniquely: '+productId);
  const registryIds=Object.keys(products);
  if(!productId&&(tasks.length!==registryIds.length||
    registryIds.some(x=>!tasks.some(p=>p.productId===x))))
    throw Error('Eagle product folders do not match registered product IDs');
  return {rootId:snapshot.rootId,rootName:snapshot.rootName,
    industries:snapshot.industries,tasks,
    total:tasks.length,toMove:tasks.filter(x=>x.state==='needs_move').length,
    alreadyCorrect:tasks.filter(x=>x.state==='already_correct').length};
}
function writeState(root,operation){
  const dir=join(root,'data','migrations','industry');
  mkdirSync(dir,{recursive:true});
  const file=join(dir,operation.productId+'-'+new Date().toISOString().replace(/[:.]/g,'-')+
    '-'+randomUUID().slice(0,8)+'.json');
  writeFileSync(file,JSON.stringify(operation,null,2)+'\n',{flag:'wx'});
  return file;
}
function saveState(file,state){
  const temp=file+'.'+randomUUID().slice(0,8)+'.tmp';
  writeFileSync(temp,JSON.stringify(state,null,2)+'\n',{flag:'wx'});
  renameSync(temp,file);
}
async function verifyPreserved(rpc,prior,parentId,folderId){
  const tree=await rpc('folder_get',{getAllHierarchy:true,fullDetails:true});
  const snapshot=inspectIndustryTree(tree);
  const found=snapshot.products.find(x=>x.productId===prior.productId);
  if(!found||found.folderId!==folderId||found.parentId!==parentId||
    found.mainFolderId!==prior.mainFolderId||found.detailFolderId!==prior.detailFolderId)
    throw Error('Eagle folder identity or parent did not verify after reparent');
  const now=await baselineOf(rpc,found);
  if(JSON.stringify(now.items)!==JSON.stringify(prior.items))
    throw Error('Eagle product/root/main/detail item association changed after reparent');
  return found;
}

export async function rollbackIndustryProduct(root,productId,{rpc=null,mode='check'}={}){
  if(!productFolderName(productId)||!['check','apply'].includes(mode))
    throw Error('Invalid industry rollback request');
  const directory=join(root,'data','migrations','industry');
  if(!existsSync(directory))throw Error('No migration history exists for this project');
  const candidates=readdirSync(directory).filter(name=>name.startsWith(productId+'-')&&
    name.endsWith('.json')&&!name.includes('-rollback-')).sort().reverse();
  if(!candidates.length)throw Error('No proven forward migration snapshot for '+productId);
  const previousFile=join(directory,candidates[0]);
  const prior=JSON.parse(readFileSync(previousFile,'utf8'));
  if(prior.status!=='complete'||prior.productId!==productId||!prior.targetParentId||
    !prior.originalParentId||prior.folderId!==prior.baseline?.folderIds?.product)
    throw Error('Latest migration snapshot is not safely reversible');
  const cfg=JSON.parse(readFileSync(join(root,'config','local.json'),'utf8'));
  const call=rpc||((name,args)=>eagleArchiveRpc(cfg.eagleMcpUrl,name,args));
  const tree=await call('folder_get',{getAllHierarchy:true,fullDetails:true});
  const layout=inspectIndustryTree(tree);
  const found=layout.products.find(x=>x.productId===productId);
  if(!found||found.folderId!==prior.folderId||found.parentId!==prior.targetParentId)
    throw Error('Current Eagle product no longer matches migration snapshot; rollback blocked');
  const info={productId,status:'rollback_ready',folderId:prior.folderId,
    currentParentId:found.parentId,originalParentId:prior.originalParentId,
    sourceSnapshot:previousFile};
  if(mode==='check')return {...info,eagleWrites:0};
  const eagle=await call('get_app_info',{});
  if(!eagle?.libraryPath)throw Error('Eagle library path unavailable');
  const unlock=guard(root);
  let unlockLibrary=null;
  try{
    unlockLibrary=acquireLibraryLock(root,eagle.libraryPath);
    const snapshot=await baselineOf(call,found);
    if(JSON.stringify(snapshot.items)!==JSON.stringify(prior.baseline.items))
      throw Error('Folder associations no longer match original snapshot; rollback blocked');
    const operation={version:1,productId,status:'planned',kind:'rollback',
      sourceSnapshot:previousFile,folderId:prior.folderId,
      fromParentId:found.parentId,toParentId:prior.originalParentId,
      baseline:snapshot,steps:[]};
    const file=writeState(root,operation);
    const commit=()=>saveState(file,operation);
    try{
      operation.steps.push({step:'rollback_intent',at:new Date().toISOString(),
        from:found.parentId,to:prior.originalParentId});
      operation.status='rollback_outcome_uncertain';commit();
      await call('folder_update',{folders:[{id:prior.folderId,parentId:prior.originalParentId}]});
      await verifyPreserved(call,{...found,...snapshot},prior.originalParentId,prior.folderId);
      operation.steps.push({step:'rollback_verified',at:new Date().toISOString()});
      operation.status='complete';commit();
      return{...info,status:'rolled_back',verifiedPreserved:true,snapshot:file};
    }catch(error){
      operation.status='needs_read_only_review';
      operation.error=String(error.message||error);commit();
      throw Error('Rollback outcome requires read-only review: '+file+' '+operation.error);
    }
  }finally{try{unlockLibrary?.()}finally{unlock()}}
}

export async function moveIndustryProduct(root,productId,{rpc=null,mode='apply',apiEndpoint=null}={}){
  if(!['apply','check'].includes(mode))throw Error('Unexpected industry move mode');
  if(!productFolderName(productId))throw Error('Invalid product ID');
  const cfg=JSON.parse(readFileSync(join(root,'config','local.json'),'utf8'));
  const call=rpc||((name,args)=>eagleArchiveRpc(apiEndpoint||cfg.eagleMcpUrl,name,args));
  const snapshot=await call('folder_get',{getAllHierarchy:true,fullDetails:true});
  const plan=planIndustryMoves(snapshot,readRegistry(root),{productId}),task=plan.tasks[0];
  if(mode==='check'||task.state==='already_correct')
    return {productId,status:task.state,target:task.targetIndustryName,folderId:task.folderId,
      parentId:task.parentId,requiresWrite:mode==='apply'&&task.state==='needs_move'};
  const owner=await call('get_app_info',{});
  if(!owner?.libraryPath)throw Error('Eagle library path unavailable for folder migration lock');
  const releaseGuard=guard(root);
  let releaseLibrary=null;
  try{
    releaseLibrary=acquireLibraryLock(root,owner.libraryPath);
    // Snapshot all three original item associations before any non-idempotent folder write.
    const livePlan=planIndustryMoves(await call('folder_get',{getAllHierarchy:true,fullDetails:true}),
      readRegistry(root),{productId}).tasks[0];
    if(livePlan.folderId!==task.folderId||livePlan.parentId!==task.parentId||
      livePlan.targetIndustryName!==task.targetIndustryName)
      throw Error('Eagle product layout changed since preflight');
    const baseline=await baselineOf(call,task);
    const state={version:1,status:'planned',productId,
      rootId:plan.rootId,folderId:task.folderId,originalParentId:task.parentId,
      originalIndustry:task.industryName,targetIndustry:task.targetIndustryName,
      industryCode:task.targetIndustryCode,
      original:task,baseline,steps:[],createdAt:new Date().toISOString()};
    const file=writeState(root,state);
    const save=()=>saveState(file,state);
    const mark=(step,extra)=>{state.steps.push({step,at:new Date().toISOString(),...extra});save()};
    const next=async()=>{
      const t=await call('folder_get',{getAllHierarchy:true,fullDetails:true});
      return inspectIndustryTree(t);
    };
    try{
      let industry=plan.industries.find(x=>x.name===task.targetIndustryName);
      if(!industry){
        mark('industry_create_intent',{name:task.targetIndustryName,parentId:plan.rootId});
        await call('folder_create',{folders:[{name:task.targetIndustryName,parentId:plan.rootId}]});
        industry=(await next()).industries.find(x=>x.name===task.targetIndustryName);
        if(!industry?.id)throw Error('Industry creation cannot be independently verified');
        mark('industry_create_verified',{name:industry.name,id:industry.id});
      }
      const live=(await next()).products.find(x=>x.productId===productId);
      if(!live||live.folderId!==task.folderId||live.parentId!==task.parentId)
        throw Error('Product parent changed before submission; do not submit move');
      if(industry.id===live.parentId){
        if(live.industryName!==task.targetIndustryName)
          throw Error('Eagle industry ID or parent topology collision');
        state.status='complete';state.targetParentId=industry.id;save();
        return{productId,status:'already_correct',folderId:task.folderId,
          parentId:industry.id,snapshot:file,verifiedPreserved:true};
      }
      // Persist intent BEFORE submitting a non-idempotent parent change.
      mark('move_intent',{folderId:task.folderId,from:task.parentId,to:industry.id});
      state.status='move_outcome_uncertain';save();
      await call('folder_update',{folders:[{id:task.folderId,parentId:industry.id}]});
      await verifyPreserved(call,{...task,...baseline},industry.id,task.folderId);
      mark('move_verified',{folderId:task.folderId,parentId:industry.id});
      state.status='complete';state.targetParentId=industry.id;
      state.completedAt=new Date().toISOString();save();
      return{productId,status:'moved',industry:task.targetIndustryName,folderId:task.folderId,
        originalParentId:task.parentId,parentId:industry.id,verifiedPreserved:true,snapshot:file};
    }catch(error){
      state.status='needs_read_only_review';state.error=String(error.message||error);save();
      throw Error('Industry move requires read-only review; snapshot '+file+' '+state.error);
    }
  }finally{try{releaseLibrary?.()}finally{releaseGuard()}}
}
