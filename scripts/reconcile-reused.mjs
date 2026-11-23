#!/usr/bin/env node
// Recover historical "Use Original" outcomes without reimporting an image.
// Require unique exact local fallback SHA or other already-verified source evidence.
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readCurrentEagleProduct,listFolderItems,hashEagleFile} from './eagle-current.mjs';
import {resolveReusedSlots} from './eagle-reuse-resolution.mjs';
import {makeMap,saveMap} from './eagle-product-map.mjs';
import {eagleArchiveRpc} from './eagle-archive.mjs';
import {acquireProductLock} from './capture-store.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [id,mode]=process.argv.slice(2);
if(!/^\d{8,16}$/.test(id||'')||!['--check','--apply'].includes(mode)||process.argv.length!==4)
 throw Error('Usage: node scripts/reconcile-reused.mjs <productId> --check|--apply');
const receiptFile=join(root,'data','runs','stable-'+id,'receipt.json');
if(!existsSync(receiptFile))throw Error('Missing original capture receipt');
const receipt=JSON.parse(readFileSync(receiptFile,'utf8'));
const configFile=name=>join(root,'config',name);
const config={...JSON.parse(readFileSync(configFile('local.example.json'),'utf8')),
 ...(existsSync(configFile('local.json'))?JSON.parse(readFileSync(configFile('local.json'),'utf8')):{})};
const rpc=(name,args)=>eagleArchiveRpc(config.eagleMcpUrl,name,args);
const release=mode==='--apply'?acquireProductLock(root,id):null;
try{
 const current=await readCurrentEagleProduct({rpc,productId:id,images:receipt.images,rootName:receipt.archive?.rootName||null});
 if(!current.folders||current.invalid.length)throw Error('Current archive cannot be mapped safely');
 if(!current.missing.length){
   console.log(JSON.stringify({status:current.sourceMode==='product_map'?'already_mapped':'nothing_to_reconcile',
    productId:id,classified:current.counts,sourceMode:current.sourceMode,changes:false},null,2));
  }else{
 const [main,detail]=await Promise.all([
   listFolderItems(rpc,current.folders.mainFolderId),
   listFolderItems(rpc,current.folders.detailFolderId)]);
 const candidates=[...main.map(x=>({...x,category:'main'})),...detail.map(x=>({...x,category:'detail'}))];
 const missing=receipt.images.filter(x=>current.missing.includes(x.name));
 const matched=await resolveReusedSlots({missing,candidates,
  localFallbacks:receipt.directFallback||[],inspect:hashEagleFile});
 if(matched.unresolved.length)throw Error('Cannot prove all shared sources: '+JSON.stringify(matched.unresolved));
 const found=new Map([...current.items,...matched.resolved].map(x=>[x.category+':'+x.order,x]));
 const images=receipt.images.map(x=>{
  const physical=found.get(x.category+':'+x.order);
  if(!physical)throw Error('Unresolved logical image '+x.name);
  return {...x,itemId:physical.itemId||physical.id,verified:true,sha256:physical.sha256,
   resolution:physical.resolution||(physical.eagleName===x.name?'imported':'reused')};
 });
 const info=await rpc('get_app_info',{});
 const map=makeMap(id,images,{libraryPath:info.libraryPath||null,
   folders:{main:current.folders.mainFolderId,detail:current.folders.detailFolderId}});
 const checked=await readCurrentEagleProduct({rpc,productId:id,images:receipt.images,productMap:map});
 if(checked.status!=='complete'||checked.missing.length||checked.invalid.length)
  throw Error('Proposed mapping does not pass independent physical re-verification');
 if(mode==='--check'){
  console.log(JSON.stringify({status:'ready',productId:id,resolved:matched.resolved.map(x=>({
   logicalName:x.name,eagleItemId:x.itemId,existingEagleName:x.eagleName,
   sha256:x.sha256})),after:{main:checked.counts.main,detail:checked.counts.detail,
   unrelated:checked.unrelated},changes:false},null,2));
 }else{
  const result=saveMap(root,map);
  console.log(JSON.stringify({status:'mapped',productId:id,path:result.path,
   resolved:matched.resolved.length,sourceMode:'product_map',
   remainingUnrelated:checked.unrelated,originalReceiptModified:false,
   itemAddCalls:0,needFolderMirror:true},null,2));
 }
}
}catch(e){
 console.error(JSON.stringify({status:'needs_read_only_review',id,error:String(e?.message||e),
  itemAddCalls:0,noAutomaticRetry:true},null,2));process.exitCode=2;
}finally{release?.()}
