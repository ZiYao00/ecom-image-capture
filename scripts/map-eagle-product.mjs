#!/usr/bin/env node
// Build a complete map from independently verified Eagle originals, then mirror
// compact order->itemId into existing category folder descriptions (no image writes).
import {readFileSync,existsSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {eagleArchiveRpc} from './eagle-archive.mjs';
import {readCurrentEagleProduct} from './eagle-current.mjs';
import {makeMap,saveMap,loadMap,embedFolderMap,parseFolderMap} from './eagle-product-map.mjs';
import {acquireProductLock} from './capture-store.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [id,mode]=process.argv.slice(2);
if(!/^\d{8,16}$/.test(id||'')||!['--check','--apply'].includes(mode)||process.argv.length!==4)
 throw Error('Usage: node scripts/map-eagle-product.mjs <productId> --check|--apply');
const receiptFile=join(root,'data','runs','stable-'+id,'receipt.json');
if(!existsSync(receiptFile))throw Error('Existing product receipt not found');
const receipt=JSON.parse(readFileSync(receiptFile,'utf8'));
if(receipt.productId!==id)throw Error('Product receipt identity mismatch');
const cfgFile=name=>join(root,'config',name);
const cfg={...JSON.parse(readFileSync(cfgFile('local.example.json'),'utf8')),
  ...(existsSync(cfgFile('local.json'))?JSON.parse(readFileSync(cfgFile('local.json'),'utf8')):{})};
const endpoint=process.env.EAGLE_MCP_URL||cfg.eagleMcpUrl;
const rpc=(name,args)=>eagleArchiveRpc(endpoint,name,args);
const release=mode==='--apply'?acquireProductLock(root,id):null;
try{
 const snapshot=await readCurrentEagleProduct({rpc,productId:id,images:receipt.images,rootName:receipt.archive?.rootName||null});
 if(snapshot.status!=='complete'||snapshot.invalid.length)
  throw Error('Current Eagle source images are not independently complete and clean');
 const byPosition=new Map(snapshot.items.map(x=>[x.category+':'+x.order,x]));
 const images=receipt.images.map(x=>{
  const item=byPosition.get(x.category+':'+x.order);
  if(!item)throw Error('Missing verified source: '+x.name);
  return {...x,itemId:item.id,verified:true,sha256:item.sha256,
   resolution:item.eagleName===x.name?'imported':'reused'};
 });
 const app=await rpc('get_app_info',{});
 const folders={main:snapshot.folders.mainFolderId,detail:snapshot.folders.detailFolderId};
 const map=makeMap(id,images,{libraryPath:app?.libraryPath||null,folders});
 const writes=[];
 for(const category of ['main','detail']){
  const folderId=folders[category];
  const raw=await rpc('folder_get',{ids:[folderId],fullDetails:true});
  const list=Array.isArray(raw)?raw:raw.folders||[];
  const folder=list.find(x=>x.id===folderId&&x.name===(category==='main'?'主图':'详情页'));
  if(!folder)throw Error('Eagle folder details unavailable '+category);
  const before=String(folder.description||'');
  const existing=parseFolderMap(before);
  if(existing&&(existing.pid!==id||existing.c!==category))throw Error('Conflicting folder description map');
  const after=embedFolderMap(before,map,category);
  writes.push({category,folderId,before,after,changed:before!==after});
 }
 if(mode==='--check'){
  console.log(JSON.stringify({status:'ready',id,mappingSlots:map.slots.length,
   distinctEagleItems:new Set(map.slots.map(x=>x.itemId)).size,
   reused:map.slots.filter(x=>x.resolution==='reused').length,
   folderDescriptions:writes.map(x=>({category:x.category,folderId:x.folderId,changed:x.changed,characters:x.after.length})),
   sourceMode:snapshot.sourceMode,changed:false},null,2));
  process.exit(0);
 }
 const saved=saveMap(root,map);
 // Folder writes are idempotent by exact description equality; never blindly retry after an uncertain RPC.
 for(const item of writes){
  if(!item.changed)continue;
  await rpc('folder_update',{folders:[{id:item.folderId,description:item.after}]});
  const returned=await rpc('folder_get',{ids:[item.folderId],fullDetails:true});
  const actual=(Array.isArray(returned)?returned:returned.folders||[]).find(x=>x.id===item.folderId);
  if(actual?.description!==item.after)throw Error('Eagle folder mapping write unverified: '+item.category);
 }
 const checked=await readCurrentEagleProduct({rpc,productId:id,images:receipt.images,rootName:receipt.archive?.rootName||null});
 if(checked.status!=='complete'||checked.sourceMode!=='product_map')
  throw Error('Product mapping did not pass live readback');
 console.log(JSON.stringify({status:'complete',id,slots:map.slots.length,
  reused:map.slots.filter(x=>x.resolution==='reused').length,
  stored:saved.path,folderDescriptionsVerified:true,sourceMode:checked.sourceMode,
  unrelatedExtras:checked.unrelated,
  originalReceiptModified:false,sourceImagesModified:false},null,2));
}catch(e){
 console.error(JSON.stringify({status:'needs_read_only_review',id,error:String(e?.message||e),
  originalReceiptModified:false,doNotRepeatUncertainWrite:true},null,2));process.exitCode=2;
}finally{release?.()}
