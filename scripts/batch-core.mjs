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
export const isRegistryComplete=existing=>existing?.status==='success'&&existing?.workflowStatus==='complete';
export function classifyBatchProduct(entry,existing,receiptExists,receipt=null,jobExists=false){
 if(!entry?.productId)throw Error('Invalid batch entry');
 // Product folders remain product-scoped. Never merge conflicting SKU identities.
 if(existing||receiptExists||jobExists){
  const known=[existing?.skuId,receipt?.skuId].filter(Boolean).map(String);
  if(new Set(known).size>1||entry.skuId&&known.some(id=>id!==String(entry.skuId)))
   return 'existing_sku_conflict';
  // Legacy callers without a SKU field keep their old classification;
  // parsed batch entries always have an explicit skuId or null.
  if(Object.hasOwn(entry,'skuId')&&(!entry.skuId||!known.length))return 'existing_sku_unknown';
 }
 if(receiptExists){
  return isRegistryComplete(existing)?'skipped_existing_complete':'skipped_existing_needs_review';
 }
 if(jobExists)return 'orphan_job_needs_review';
 if(existing)return 'skipped_registry_without_receipt';
 return 'ready_for_new_capture';
}

export function parseBatchOptions(args){
 if(!Array.isArray(args)||!args[0]||args[0].startsWith('--'))throw Error('Missing batch input file');
 let mode='--check',engine='v2',modeSeen=false,engineSeen=false;
 for(let i=1;i<args.length;i++){
  const a=args[i];
  if(['--check','--apply'].includes(a)&&!modeSeen){mode=a;modeSeen=true;continue}
  if(a==='--engine'&&!engineSeen&&['v2','v3'].includes(args[i+1])){engine=args[++i];engineSeen=true;continue}
  throw Error('Invalid batch option: '+a);
 }
 return {file:args[0],mode,engine};
}
export const BATCH_BUDGETS=Object.freeze({capture:600000,recovery:2400000,read:240000,index:310000});
// Only old persisted attempts/jobs can block a later batch; unrelated legacy
// receipts are not globally reclassified by this queue.
export function collectBatchBarriers({journals=[],jobs=[],products={}}={}){
 const out=new Map();
 const add=(id,reason)=>{if(!/^\d{8,16}$/.test(String(id)))throw Error('Invalid persisted batch product');if(!out.has(id))out.set(id,{productId:id,reason})};
 for(const job of jobs){
  if(!job||!Array.isArray(job.slots)||!job.slots.length)throw Error('Malformed persisted V3 job');
  if(!isRegistryComplete(products[job.productId])||job.state!=='verified'||job.slots.some(x=>x.state!=='verified'))
   add(job.productId,'unfinished_v3_job');
 }
 for(const journal of journals){
  if(!Array.isArray(journal.items))throw Error('Malformed prior batch journal');
  for(const row of journal.items){
   const id=row.productId||row.id;
   if(isRegistryComplete(products[id]))continue;
   if(['invoking_capture','invoking_recovery','invoking_finalize','needs_read_only_recovery','needs_browser_safe_resume'].includes(row.status)&&row.zeroWriteLocalScan!==true)
    add(id,'unresolved_prior_batch_attempt');
  }
 }
 return [...out.values()];
}
export function runBatchQueue({entries,engine='v2',classify,barriers,run,saveRow,canRecover,
  refreshIndex,verifyDelivery,canAutoRecover=()=>true}){
 const summary=[];
 let halt=null;
 const finish=(entry,status,extra={})=>{
  const row={id:entry.productId,status,...extra};saveRow(entry,row);summary.push(row);return row;
 };
 const fail=(entry,status,extra={})=>{
  halt={productId:entry.productId,status,error:extra.error||status};
  return finish(entry,status,extra);
 };
 for(const entry of entries){
  if(halt){finish(entry,'not_started_due_to_batch_halt',{error:'Blocked by '+halt.productId});continue}
  const state=classify(entry),blocking=barriers().filter(x=>x.productId!==entry.productId);
  if(state==='skipped_existing_complete'){
   const checked=verifyDelivery(entry);
   if(checked.ok){finish(entry,state,{verification:checked.result});continue}
   fail(entry,'needs_read_only_recovery',{error:checked.error||'Existing product failed live verification'});continue;
  }
  // No unrelated new writes while an earlier batch/job remains unresolved.
  if(blocking.length){
   fail(entry,'blocked_by_prior_attempt',{error:'Resolve prior persisted attempt first: '+blocking[0].productId,blockers:blocking});continue;
  }
  if(state==='ready_for_new_capture'&&barriers().some(x=>x.productId===entry.productId)){
   fail(entry,'needs_read_only_recovery',{error:'Prior attempt without authoritative receipt; no new capture'});continue;
  }
  let attempt;
  if(state==='ready_for_new_capture'){
   if(engine==='v3'){
    const indexed=refreshIndex();
    if(!indexed.ok){fail(entry,'needs_read_only_recovery',{error:indexed.error||'Index refresh blocked'});continue}
   }
   saveRow(entry,{status:'invoking_capture'});
   attempt=run('capture',entry);
   if(!attempt.ok&&engine==='v3'&&canAutoRecover(attempt)&&canRecover(entry)){
    // The recovery command itself must prove every submitted slot by readback.
    // One bounded recovery path, not a repeat of capture/item_add.
    saveRow(entry,{status:'invoking_recovery',captureError:attempt.error});
     attempt=run('recover',entry);
   }
  }else if(state==='skipped_existing_needs_review'&&engine==='v3'&&canRecover(entry)){
   saveRow(entry,{status:'invoking_recovery'});
   attempt=run('recover',entry);
  }else{
   fail(entry,state,{error:'Existing identity or durable state needs review'});continue;
  }
  if(!attempt?.ok){
   const status=attempt?.result?.status==='incomplete_before_eagle'?'needs_browser_safe_resume':'needs_read_only_recovery';
   // Only the explicitly proven local scan failure can continue.
   if(!shouldHaltBatchAfterAttempt({status,result:attempt?.result,receipt:attempt?.receipt})){
    finish(entry,status,{error:attempt.error,zeroWriteLocalScan:true});continue;
   }
   fail(entry,status,{error:attempt?.error||'Capture or recovery did not complete'});continue;
  }
  saveRow(entry,{status:'invoking_finalize'});
  const verified=verifyDelivery(entry,{apply:attempt.recovered===true&&!attempt.finalized});
  if(!verified.ok){fail(entry,'needs_read_only_recovery',{error:verified.error||'Independent verification failed'});continue}
  finish(entry,'complete',{verification:verified.result});
 }
 return {summary,halt};
}

// A shared Eagle/browser failure can poison every later product in the same queue.
// Only a positively identified, product-local scan failure before Eagle writes may continue.
export function shouldHaltBatchAfterAttempt({status,result,receipt}={}){
  if(status==='complete')return false;
  const localScan=result?.status==='incomplete_before_eagle'&&
    /^Chrome: Main\/detail images incomplete:/.test(String(result?.error||''))&&
    receipt?.phase==='incomplete_before_eagle'&&receipt?.eagle==='not_called'&&
    Array.isArray(receipt?.images)&&receipt.images.length===0&&
    !(receipt?.eagleBatches?.length);
  return !localScan;
}
