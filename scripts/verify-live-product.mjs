#!/usr/bin/env node
// Authoritative current Eagle archive + long-image verification to update local product registry.
// Original capture receipts remain immutable. Never calls item_add.
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {readRegistry,updateProduct,acquireProductLock} from './capture-store.mjs';
import {eagleArchiveRpc} from './eagle-archive.mjs';
import {readCurrentEagleProduct,listFolderItems,hashEagleFile} from './eagle-current.mjs';
import {planEagleStitch} from './stitch-eagle-core.mjs';
import {syncIndustryAfterProductComplete} from './industry-eagle.mjs';
import {verifyDeliveryMode} from './copy-delivery.mjs';
import {holdWorkflowLock} from './workflow-lock.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [id,mode]=process.argv.slice(2);
if(!/^\d{8,16}$/.test(id||'')||!['--check','--apply'].includes(mode)||process.argv.length!==4)
 throw Error('Usage: node scripts/verify-live-product.mjs <productId> --check|--apply');
const receiptFile=join(root,'data','runs','stable-'+id,'receipt.json');
if(!existsSync(receiptFile))throw Error('No original capture receipt');
const receipt=JSON.parse(readFileSync(receiptFile,'utf8'));
if(receipt.productId!==id||!Array.isArray(receipt.images))throw Error('Invalid original receipt');
const old=readRegistry(root).products[id];
if(!old)throw Error('Product absent from registry');
const local=name=>{const p=join(root,'config',name);return existsSync(p)?JSON.parse(readFileSync(p,'utf8')):{}};
const cfg={...local('local.example.json'),...local('local.json')};
const endpoint=process.env.EAGLE_MCP_URL||cfg.eagleMcpUrl;
if(!endpoint)throw Error('Eagle MCP URL unavailable');
const rpc=(name,args)=>eagleArchiveRpc(endpoint,name,args);
if(mode==='--apply')holdWorkflowLock(root);
const unlock=mode==='--apply'?acquireProductLock(root,id):null;
try{
 const snapshot=await readCurrentEagleProduct({rpc,productId:id,images:receipt.images,rootName:receipt.archive?.rootName||null});
 const mapExtrasNonBlocking=snapshot.sourceMode==='product_map';
 const summary={productId:id,sourceMode:snapshot.sourceMode,
   unrelatedExtrasNonBlocking:mapExtrasNonBlocking,archiveStatus:snapshot.status,expected:snapshot.expected,classified:snapshot.counts,
   missing:snapshot.missing,invalid:snapshot.invalid,unrelated:snapshot.unrelated,
   formatChanges:snapshot.formatChanges,longStatus:'not_checked',longParts:[],originalReceiptPhase:receipt.phase,
   registryStatusBefore:old.status,registryWorkflowBefore:old.workflowStatus,verifiedAt:new Date().toISOString()};
 if(snapshot.status==='complete'&&(mapExtrasNonBlocking||!snapshot.unrelated.length)){
  const plan=planEagleStitch(snapshot,{width:750});
  const files=await listFolderItems(rpc,snapshot.folders.productFolderId);
  for(let i=0;i<plan.names.length;i++){
   const candidates=files.filter(x=>x.name===plan.names[i]);
   if(candidates.length!==1){summary.longStatus='missing_or_ambiguous';break;}
   const item=candidates[0];
   if(item.width!==plan.width||item.height!==plan.partHeights[i]||
      !(item.folders||[]).includes(snapshot.folders.productFolderId)){
     summary.longStatus='dimensions_or_folder_mismatch';break;
   }
   try{
    const file=await hashEagleFile(item);
    summary.longParts.push({name:item.name,itemId:item.id,width:item.width,height:item.height,bytes:file.bytes,sha256:file.sha256});
   }catch(e){summary.longStatus='physical_file_invalid';summary.longError=String(e.message||e);break;}
  }
  if(summary.longParts.length===plan.names.length&&summary.longStatus==='not_checked')
   summary.longStatus='complete';
 }
 const eagleComplete=summary.archiveStatus==='complete'&&(mapExtrasNonBlocking||!summary.unrelated.length)&&summary.longStatus==='complete';
 if(eagleComplete){
  try{summary.delivery=await verifyDeliveryMode(snapshot,receipt,old)}catch(e){summary.delivery={status:'incomplete',mode:receipt.storageMode||old.storageMode||'copy',error:String(e.message||e)}}
 }else summary.delivery={status:'not_checked'};
 const complete=eagleComplete&&summary.delivery.status==='complete';
 summary.status=complete?'complete':'incomplete';
 if(mode==='--check'){
  console.log(JSON.stringify({...summary,apply:false,registryModified:false},null,2));
  if(!complete)process.exitCode=2;
 }else{
  if(!complete)throw Error('Cannot mark product complete until Eagle archive, long parts and recorded storage-mode delivery verify');
  const dir=join(root,'data','reconciliations');mkdirSync(dir,{recursive:true});
  const file=join(dir,'live-'+id+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,6)+'.json');
  writeFileSync(file,JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
  const patch={productId:id,status:'success',workflowStatus:'complete',eagleStatus:'verified',
   archiveStatus:'complete',verifiedCount:summary.expected.main+summary.expected.detail,
   liveVerifiedAt:summary.verifiedAt,liveVerification:'eagle_physical_items_and_long_hashes',
   liveSnapshot:file,longStatus:'verified',...(summary.delivery.mode==='copy'?{localStatus:'complete',copiedCount:summary.delivery.verified,htmlStatus:'verified'}:{})};
  const updated=await updateProduct(root,patch);
  const industrySync=await syncIndustryAfterProductComplete(root,id);
  console.log(JSON.stringify({...summary,industrySync,apply:true,registryModified:true,
   registryStatusAfter:updated.status,registryWorkflowAfter:updated.workflowStatus,snapshot:file},null,2));
 }
}catch(e){
 console.error(JSON.stringify({status:'needs_read_only_review',productId:id,error:String(e.message||e),
   originalReceiptModified:false,noReimport:true},null,2));process.exitCode=2;
}finally{unlock?.()}
