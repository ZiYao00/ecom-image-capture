// Receipt-to-registry reconciliation; no browser, Eagle, item_add or image writes.
// Only a fully verified successful stable receipt may repair captures.json.
import {existsSync,readFileSync,statSync,createReadStream} from 'node:fs';
import {resolve,join,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {readRegistry,updateProduct,captureSummary,acquireProductLock} from './capture-store.mjs';

const fields=['productId','skuId','url','status','mainCount','detailCount',
 'verifiedCount','copiedCount','durationMs','outputDir'];
export function expectedFromReceipt(root,id){
 if(!/^\d{8,16}$/.test(id))throw Error('Invalid product ID');
 if(id==='910333188743')
  return {status:'legacy',productId:id,reason:'R01 has a different receipt schema; use check-project.mjs --deep'};
 const file=join(root,'data','runs','stable-'+id,'receipt.json');
 if(!existsSync(file))return {status:'absent',productId:id,reason:'Stable receipt does not exist'};
 const original=readFileSync(file),receipt=JSON.parse(original.toString('utf8'));
 if(receipt.productId!==id)throw Error('Receipt product ID mismatch: '+id);
 if(receipt.phase!=='success')
  return {status:'incomplete',productId:id,phase:receipt.phase,receipt};
 if(receipt.eagle!=='verified'||!Array.isArray(receipt.images)||!receipt.images.length||
    !receipt.selected||receipt.selected.main+receipt.selected.detail!==receipt.images.length||
    receipt.copied!==receipt.images.length||
    receipt.images.some(x=>x.verified!==true||!x.filePath||!x.itemId))
  throw Error('Successful receipt has incomplete Eagle verification: '+id);
 const entry=readRegistry(root).products[id]||null;
 const dest=receipt.destination||entry?.outputDir;
 if(!dest)throw Error('No verified destination for receipt '+id);
 if(receipt.destination&&entry?.outputDir&&resolve(receipt.destination)!==resolve(entry.outputDir))
  throw Error('Receipt destination conflicts with captures.json: '+id);
 const expected=captureSummary(receipt,{url:entry?.url,outputDir:dest});
 if(entry?.skuId&&expected.skuId!==entry.skuId)
  throw Error('Receipt SKU conflicts with captures.json: '+id);
 return {status:'success',productId:id,receipt,receiptFile:file,original,expected,registered:entry};
}
export function compareSummary(expected,registered){
 if(!registered)return [{field:'record',registered:null,expected:'verified_success'}];
 const differences=[];
 for(const field of fields){
  let x=expected[field]??null,y=registered[field]??null;
  if(field==='outputDir'&&x&&y){x=resolve(x);y=resolve(y)}
  if(x!==y)differences.push({field,registered:y,expected:x});
 }
 return differences;
}
const sha256=file=>new Promise((resolveHash,reject)=>{
 const h=createHash('sha256'),s=createReadStream(file);
 s.on('data',chunk=>h.update(chunk));s.once('error',reject);
 s.once('end',()=>resolveHash(h.digest('hex')));
});
export async function verifyReceiptCopies(receipt,destination,{hash=true}={}){
 const seen=new Set();
 for(const x of receipt.images){
  if(!['main','detail'].includes(x.category)||!Number.isInteger(x.order)||x.order<1)
   throw Error('Invalid item category/order: '+x.name);
  const ext=String(x.ext||extname(x.filePath).slice(1)||'jpg').toLowerCase().replace(/[^a-z0-9]/g,'');
  if(!ext)throw Error('Missing extension: '+x.name);
  const filename=join(resolve(destination),x.category,String(x.order).padStart(2,'0')+'.'+ext);
  if(seen.has(filename))throw Error('Duplicate local destination: '+filename);
  seen.add(filename);
  if(!existsSync(filename)||!existsSync(x.filePath))
   throw Error('Missing source/copied image: '+x.name);
  if(!statSync(filename).isFile()||!statSync(x.filePath).isFile()||
     statSync(filename).size===0||statSync(filename).size!==statSync(x.filePath).size)
   throw Error('Invalid source/copied size: '+x.name);
  if(hash&&await sha256(filename)!==await sha256(x.filePath))
   throw Error('SHA-256 mismatch: '+x.name);
 }
 return {filesChecked:receipt.images.length,sha256Checked:hash?receipt.images.length:0};
}
export async function reconcileProduct(root,id,{apply=false,deep=false}={}){
 let unlock;
 if(apply)unlock=acquireProductLock(root,id);
 try{
  const v=expectedFromReceipt(root,id);
  if(v.status!=='success'){
   const index=readRegistry(root).products[id]||null;
   const conflicting=index?.status==='success'&&(v.status==='absent'||v.status==='incomplete');
   return {productId:id,status:conflicting?'conflict':v.status,
    reason:v.reason||v.phase||'Index success is not backed by a successful receipt',changed:false};
  }
  const differences=compareSummary(v.expected,v.registered);
  if(!differences.length)return {productId:id,status:'consistent',changed:false};
  if(!apply){
   const validation=await verifyReceiptCopies(v.receipt,v.expected.outputDir,{hash:deep});
   return {productId:id,status:'out_of_sync',differences,...validation,changed:false};
  }
  const validation=await verifyReceiptCopies(v.receipt,v.expected.outputDir,{hash:true});
  if(!readFileSync(v.receiptFile).equals(v.original))
   throw Error('Receipt changed during validation. Retry after capture completes.');
  // A second read under the product lock prevents overwriting a newer registry state.
  const now=readRegistry(root).products[id]||null;
  if(compareSummary(v.expected,now).length===0)
   return {productId:id,status:'consistent',changed:false};
  if(now?.status==='success'&&v.expected.status!=='success')
   throw Error('Refusing successful product downgrade');
  const repaired=await updateProduct(root,v.expected);
  return {productId:id,status:'repaired',changed:true,...validation,
   productStatus:repaired.status,differences};
 }finally{unlock?.()}
}
