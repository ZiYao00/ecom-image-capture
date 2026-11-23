// Canonical capture registry. One product = one record. Lock only short writes,
// plus per-product jobs to prevent concurrent duplicate Eagle item_add.
import {readFileSync,writeFileSync,renameSync,mkdirSync,existsSync,rmSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {inspectLock,archiveStaleLock} from './lock-health.mjs';
import {classifyProductTitle} from './industry-core.mjs';

export const schemaVersion=1;
const wait=ms=>new Promise(done=>setTimeout(done,ms));
export function registryPath(root){return join(root,'data','captures.json');}
export function canonicalProductUrl(link){
  const u=new URL(link);
  const productId=u.searchParams.get('id');
  if(u.protocol!=='https:'||u.hostname!=='detail.tmall.com'||u.pathname!=='/item.htm'||!/^\d{8,16}$/.test(productId||''))throw Error('Invalid Tmall product link');
  const skuId=u.searchParams.get('skuId');
  if(skuId!==null&&!/^\d+$/.test(skuId))throw Error('Unexpected SKU format');
  return {productId,skuId:skuId||null,
    url:'https://detail.tmall.com/item.htm?id='+productId+(skuId?'&skuId='+skuId:'')};
}
export function readRegistry(root){
  const file=registryPath(root);
  if(!existsSync(file))throw Error('Missing data/captures.json; complete one-time migration first');
  const data=JSON.parse(readFileSync(file,'utf8'));
  if(data.schemaVersion!==schemaVersion||!data.products||
     typeof data.products!=='object'||Array.isArray(data.products))
    throw Error('Invalid captures registry schema; refusing write');
  for(const [id,item] of Object.entries(data.products)){
    if(!/^\d{8,16}$/.test(id)||item.productId!==id)
      throw Error('captures.json contains an invalid product key '+id);
  }
  return data;
}
export function captureSummary(receipt,options={}){
  const id=String(receipt.productId||'');
  if(!/^\d{8,16}$/.test(id))throw Error('Invalid receipt product ID');
  const input=options.url||'https://detail.tmall.com/item.htm?id='+id+
   (receipt.skuId?'&skuId='+receipt.skuId:'');
  const urlData=canonicalProductUrl(input);
  if(id!==urlData.productId)throw Error('Receipt and URL disagree on product ID');
  const items=Array.isArray(receipt.images)?receipt.images:[];
  const mainCount=Number(receipt.selected?.main??items.filter(i=>i.category==='main').length);
  const detailCount=Number(receipt.selected?.detail??items.filter(i=>i.category==='detail').length);
  const copiedCount=Number(receipt.copied||0);
  const verifiedCount=items.filter(i=>i.verified===true||i.status==='verifiedPresent').length;
  const outputDir=options.outputDir||receipt.destination||null;
  return {productId:id,skuId:receipt.skuId||urlData.skuId||null,url:urlData.url,
    status:String(receipt.phase||'pending'),mainCount,detailCount,verifiedCount,copiedCount,
    eagleStatus:receipt.eagle||null,htmlStatus:receipt.postprocess?.html?.status||null,
    directFallbackCount:Array.isArray(receipt.directFallback)?receipt.directFallback.length:0,
    localStatus:receipt.localStatus||null,
    storageMode:receipt.storageMode||'copy',archiveStatus:receipt.archive?.status||null,
    workflowStatus:receipt.phase==='success'&&receipt.archive?.status==='complete'&&
      (!receipt.autoStitchEnabled||['complete','already_complete'].includes(receipt.postprocess?.stitch?.status))&&
       (!receipt.productMap||receipt.productMap.status==='complete'&&receipt.productMap.mirrorStatus==='complete')?'complete':'incomplete',
    durationMs:Number.isFinite(receipt.totalMs)?receipt.totalMs:null,outputDir:outputDir?resolve(outputDir):null,
    ...(typeof receipt.title==='string'&&receipt.title.trim()?{classification:classifyProductTitle(receipt.title)}:{})};
}
export async function withShortLock(root,doWork,{timeoutMs=12000,recoveryOptions={}}={}){
 const dir=join(root,'data','.captures-write-lock');
 mkdirSync(dirname(dir),{recursive:true});
 const started=Date.now(),token=randomUUID();
 while(true){
  try{mkdirSync(dir);break}
  catch(e){
   if(e.code!=='EEXIST')throw e;
   const state=inspectLock(root,'registry',recoveryOptions);
   if(state.status==='stale'){
    try{archiveStaleLock(root,'registry',recoveryOptions);continue}
    catch(err){
     if(!existsSync(dir))continue; // another Agent may have archived first
     throw Error('Stale registry lock could not be archived safely: '+err.message);
    }
   }
   if(Date.now()-started>timeoutMs)throw Error('captures.json lock: '+state.status+
    '. Run node scripts/lock-health-cli.mjs status; never delete an active/unknown lock.');
   await wait(20+Math.floor(Math.random()*30));
  }
 }
 try{
  writeFileSync(join(dir,'owner.json'),JSON.stringify({token,pid:process.pid,startedAt:new Date().toISOString()}),{flag:'wx'});
  return await doWork();
 }finally{rmSync(dir,{recursive:true,force:true})}
}
export async function updateProduct(root,patch,{allowSuccessDowngrade=false}={}){
 if(!patch||!/^\d{8,16}$/.test(patch.productId||''))throw Error('Invalid product update');
 const id=patch.productId;
 return withShortLock(root,()=>{
  const data=readRegistry(root),old=data.products[id]||null;
  if(!allowSuccessDowngrade&&old?.status==='success'&&patch.status&&patch.status!=='success')
   throw Error('Cannot downgrade successful product '+id);
  if(old?.outputDir&&patch.outputDir&&resolve(old.outputDir)!==resolve(patch.outputDir))
   throw Error('Recorded output directory conflict: '+id);
  if(old?.skuId&&patch.skuId&&old.skuId!==patch.skuId)
   throw Error('Existing SKU conflicts with the supplied SKU for product '+id);
  const next={...old,...patch,productId:id};
  // A manual product classification is authoritative across capture/recovery updates.
  if(old?.classification?.manualLocked&&patch.classification?.source!=='manual')
    next.classification=old.classification;
  if(old?.skuId&&!next.skuId)next.skuId=old.skuId;
  if(old?.outputDir&&!next.outputDir)next.outputDir=old.outputDir;
  if(old?.url&&!patch.url)next.url=old.url;
  if(!next.url)next.url=canonicalProductUrl('https://detail.tmall.com/item.htm?id='+id).url;
  const validated=canonicalProductUrl(next.url);
  if(validated.productId!==id)throw Error('Registry URL does not match product ID');
  if(next.skuId && validated.skuId!==next.skuId)
    next.url=canonicalProductUrl('https://detail.tmall.com/item.htm?id='+id+'&skuId='+next.skuId).url;
  data.products[id]=next;
  const file=registryPath(root),tmp=file+'.'+process.pid+'.'+randomUUID()+'.tmp';
  try{
   writeFileSync(tmp,JSON.stringify(data,null,2)+'\n',{flag:'wx'});
   renameSync(tmp,file);
  }catch(e){if(existsSync(tmp))rmSync(tmp,{force:true});throw e}
  return next;
 });
}
// Only touch the classification field; old Taobao records must retain their original URLs.
// Never route a classification-only backfill through canonicalProductUrl validation.
export async function updateProductClassification(root,id,classification){
  if(!/^\d{8,16}$/.test(id||'')||!classification||typeof classification!=='object')
    throw Error('Invalid product classification patch');
  return withShortLock(root,()=>{
    const data=readRegistry(root),old=data.products[id];
    if(!old)throw Error('Classification target not registered: '+id);
    if(old.classification?.manualLocked&&classification.source!=='manual')return old;
    const next={...old,classification},file=registryPath(root);
    data.products[id]=next;
    const tmp=file+'.industry-'+process.pid+'-'+randomUUID()+'.tmp';
    try{
      writeFileSync(tmp,JSON.stringify(data,null,2)+'\n',{flag:'wx'});
      renameSync(tmp,file);
    }catch(err){if(existsSync(tmp))rmSync(tmp,{force:true});throw err}
    return next;
  });
}

export function acquireProductLock(root,id,{recoveryOptions={}}={}){
 if(!/^\d{8,16}$/.test(id))throw Error('Invalid product ID');
 const dir=join(root,'data','locks','product-'+id+'.lock');
 mkdirSync(dirname(dir),{recursive:true});
 let locked=false;
 for(let attempt=0;attempt<2;attempt++){
  try{mkdirSync(dir);locked=true;break}
  catch(e){
   if(e.code!=='EEXIST')throw e;
   const state=inspectLock(root,id,recoveryOptions);
   if(state.status!=='stale')throw Error('Product '+id+' lock is '+state.status+
    '; another Agent may still own it. Inspect with scripts/lock-health-cli.mjs');
   try{archiveStaleLock(root,id,recoveryOptions)}
   catch(err){
    if(!existsSync(dir))continue; // another process recovered it first
    throw Error('Stale product lock recovery blocked: '+err.message);
   }
  }
 }
 if(!locked)throw Error('Product '+id+' lock changed during recovery; retry after inspection');
 const token=randomUUID();
 try{writeFileSync(join(dir,'owner.json'),JSON.stringify({pid:process.pid,token,startedAt:new Date().toISOString()})+'\n',{flag:'wx'})}
 catch(e){rmSync(dir,{recursive:true,force:true});throw e}
 let released=false;
 function release(){
  if(released)return;
  released=true;
  try{
   const owner=JSON.parse(readFileSync(join(dir,'owner.json'),'utf8'));
   if(owner.token===token)rmSync(dir,{recursive:true,force:true});
  }catch{/* If uncertain, leave lock for manual inspection. */}
 }
 process.once('exit',release);
 return release;
}
