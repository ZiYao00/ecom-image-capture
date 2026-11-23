// Deterministic, side-effect-free input and preflight state for the serial batch runner.
import {canonicalProductUrl} from './capture-store.mjs';
export function parseBatchUrls(content,{maxItems=40}={}){
 if(typeof content!=='string'||content.length>250000)throw Error('Invalid or oversized batch file');
 const source=content.replace(/^\uFEFF/,'').trim();
 if(!source)throw Error('Empty batch file');
 let lines;
 if(source.startsWith('[')){
  const value=JSON.parse(source);
  if(!Array.isArray(value)||!value.every(x=>typeof x==='string'))throw Error('JSON batch input must be an array of full URL strings');
  lines=value;
 }else lines=source.split(/\r?\n/).map(x=>x.trim()).filter(x=>x&&!x.startsWith('#'));
 if(!lines.length||lines.length>maxItems)throw Error('Batch count must be 1..'+maxItems);
 const used=new Set();
 return lines.map((fullUrl,index)=>{
  if(typeof fullUrl!=='string'||fullUrl.length>8192||/\s/.test(fullUrl))throw Error('Invalid URL line '+(index+1));
  const product=canonicalProductUrl(fullUrl);
  if(used.has(product.productId))throw Error('Duplicate product in batch: '+product.productId);
  used.add(product.productId);
  return {index:index+1,productId:product.productId,skuId:product.skuId,
    fullUrl,canonicalUrl:product.url};
 });
}
export function classifyBatchProduct(entry,existing,receiptExists){
 if(!entry?.productId)throw Error('Invalid batch entry');
 if(receiptExists){
  return existing?.status==='success'&&existing?.workflowStatus==='complete'
   ?'skipped_existing_complete':'skipped_existing_needs_review';
 }
 if(existing)return 'skipped_registry_without_receipt';
 return 'ready_for_new_capture';
}
