#!/usr/bin/env node
// AA/BB source-only closeout. Snapshot first; never delete, download, or import originals.
import {readFileSync,writeFileSync,appendFileSync,mkdirSync,existsSync,readdirSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readRegistry,canonicalProductUrl} from './capture-store.mjs';
import {eagleArchiveRpc,ensureEagleProductFolders,ECOM_ARCHIVE_ROOT} from './eagle-archive.mjs';
import {createV3ReadbackRpc} from './v3-web-readback.mjs';
import {eagleV2GetById} from './v3-eagle-import.mjs';
import {inspectIndexedItem} from './v3-fingerprint.mjs';
import {loadMap} from './eagle-product-map.mjs';
import {listFolderItems} from './eagle-current.mjs';
import {acquireLibraryLock} from './v3-job-state.mjs';
import {assertIndustryMigrationNotActive} from './eagle-industry-move.mjs';
import {locateSourceFolder,planSourceCloseout,applySourceCloseout} from './source-closeout-core.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [name,mode,token]=process.argv.slice(2);
if(!['AA','BB'].includes(name)||!['--check','--prepare','--apply'].includes(mode)||
   (mode==='--apply'?!/^[a-f0-9-]{36}$/.test(token||''):token!==undefined)||process.argv.length>(mode==='--apply'?5:4))
 throw Error('Usage: ecom source-closeout AA|BB --check|--prepare | --apply <snapshotId>');
const conf=n=>{const p=join(root,'config',n);return existsSync(p)?JSON.parse(readFileSync(p,'utf8')):{}};
const cfg={...conf('local.example.json'),...conf('local.json')};
const rpc=(n,args)=>eagleArchiveRpc(cfg.eagleMcpUrl,n,args);
const app=await rpc('get_app_info',{});
if(!app?.libraryPath)throw Error('Current Eagle library unavailable');
const folderId=locateSourceFolder(await rpc('folder_get',{getAllHierarchy:true,fullDetails:true}),name);
const readRpc=createV3ReadbackRpc({eagleMcpUrl:cfg.eagleMcpUrl,libraryPath:app.libraryPath});
const dir=join(root,'data','source-closeout');
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const inspectSource=async item=>{
 const proof=await inspectIndexedItem(app.libraryPath,item);
 if(!proof)throw Error('Physical source could not be verified');
 return proof;
};
async function resolveProduct(identity){
 const id=identity.productId,record=readRegistry(root).products[id];
 const f=join(root,'data','runs','stable-'+id,'receipt.json');
 if(record?.status!=='success'||record.workflowStatus!=='complete'||!existsSync(f))
  return {status:'pending'};
 const receipt=JSON.parse(readFileSync(f,'utf8'));
 if(receipt.productId!==id||(record.skuId||null)!==identity.skuId||(receipt.skuId||null)!==identity.skuId)
  return {status:'sku_conflict'};
 const map=loadMap(root,id,receipt.images);
 if(!map||map.status!=='complete'||map.libraryPath?.toLowerCase()!==app.libraryPath.toLowerCase())
  return {status:'map_not_verified'};
 const folders=await ensureEagleProductFolders({rpc,productId:id,rootName:cfg.eagleArchiveRootName||ECOM_ARCHIVE_ROOT,apply:false});
 if(!folders||folders.main!==map.folders?.main||folders.detail!==map.folders?.detail||
  (receipt.folderIds?.product&&folders.product!==receipt.folderIds.product))return {status:'folder_conflict'};
 const p=spawnSync(process.execPath,[join(root,'scripts','ecom.mjs'),'verify-live',id,'--check'],
  {cwd:root,encoding:'utf8',windowsHide:true,timeout:240000,maxBuffer:8*1024*1024});
 let result;try{result=JSON.parse(p.stdout)?.result}catch{}
 if(p.error||p.status!==0||result?.status!=='complete')return {status:'delivery_not_verified'};
 return {status:'complete',skuId:identity.skuId,main:folders.main,detail:folders.detail,slots:map.slots};
}
async function currentPlan(){
 const items=await listFolderItems(readRpc,folderId);
 return planSourceCloseout({folderName:name,folderId,libraryPath:app.libraryPath,items,resolveProduct,inspectSource});
}
if(mode!=='--apply'){
 const plan=await currentPlan(),report={status:'checked',mode,plan,ready:plan.ready.length,pending:plan.pending.length,eagleWrites:0};
 if(mode==='--prepare'){
  mkdirSync(dir,{recursive:true});
  const id=randomUUID(),file=join(dir,id+'.json');
  writeFileSync(file,JSON.stringify({id,plan,sha256:sha(plan),createdAt:new Date().toISOString()},null,2)+'\n',{flag:'wx'});
  Object.assign(report,{status:'prepared',snapshotId:id,snapshotSha256:sha(plan)});
 }
 console.log(JSON.stringify(report,null,2));
}else{
 assertIndustryMigrationNotActive(root);
 const release=acquireLibraryLock(root,'batch:'+app.libraryPath);
 try{
  const saved=JSON.parse(readFileSync(join(dir,token+'.json'),'utf8')),plan=saved.plan;
  if(saved.id!==token||saved.sha256!==sha(plan)||plan.folderName!==name)throw Error('Source snapshot identity/digest mismatch');
  const pending=[];
  for(const f of readdirSync(dir).filter(x=>x.endsWith('.events.jsonl'))){
   const rows=readFileSync(join(dir,f),'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
   const head=rows[0];
   if(!head||head.event!=='start'||typeof head.libraryPath!=='string')throw Error('Invalid source-closeout event log');
   if(head.libraryPath.toLowerCase()!==app.libraryPath.toLowerCase())continue;
   const localPending=new Map();
   for(const e of rows.slice(1)){
    if(!['intent','verified'].includes(e.event))continue;
    const key=e.sourceId+':'+e.action+':'+e.folderId;
    if(e.event==='intent')localPending.set(key,e);else localPending.delete(key);
   }
   pending.push(...localPending.values());
  }
  const eventPath=join(dir,token+'-'+randomUUID().slice(0,8)+'.events.jsonl');
  const log=e=>appendFileSync(eventPath,JSON.stringify({at:new Date().toISOString(),...e})+'\n');
  writeFileSync(eventPath,JSON.stringify({event:'start',snapshotId:token,libraryPath:app.libraryPath,sha256:saved.sha256,at:new Date().toISOString()})+'\n',{flag:'wx'});
  const proofs=new Map();
  const readProof=async row=>{
   const item=await eagleV2GetById(row.sourceId);
   if(!item||item.isDeleted)throw Error('Source item absent');
   const physical=await inspectSource(item);
   const identity=canonicalProductUrl(item.url||item.website);
   const key=identity.url;
   if(!proofs.has(key))proofs.set(key,await resolveProduct(identity));
   const p=proofs.get(key);
   if(p?.status!=='complete')throw Error('Target delivery no longer complete');
   const linked=p.slots.filter(s=>s.itemId===item.id);
   if(linked.some(s=>s.sha256!==physical.sha256))throw Error('Source hash conflicts with verified map');
   const target=linked.length?p[linked[0].category]:p.main;
   return {sourceId:item.id,productId:identity.productId,skuId:identity.skuId,url:identity.url,
     sha256:physical.sha256,folders:item.folders,target};
  };
  const report=await applySourceCloseout({plan,libraryPath:app.libraryPath,folderId,readProof,
   link:(id,fid)=>rpc('item_add_to_folders',{ids:[id],folders:[fid]}),
   unlink:(id,fid)=>rpc('item_remove_from_folders',{ids:[id],folders:[fid]}),
   log,priorIntents:pending});
  log({event:'complete',report});
  const remaining=await listFolderItems(readRpc,folderId);
  console.log(JSON.stringify({...report,snapshotId:token,eventPath,remaining:remaining.length,
   unrelatedNewItems:remaining.filter(x=>!plan.sourceIds.includes(x.id)).length},null,2));
 }finally{release()}
}
