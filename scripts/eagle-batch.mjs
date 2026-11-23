// Journaled Eagle import, bounded batches. Never retries item_add.
import {verifyEagleReadback} from './eagle-readback.mjs';

export async function importEagleInBatches(images,{add,read,exists,record=()=>{},
  batchSize=8,delays=[500,1200,2500],folderIds=null,resolveReused=null}={}){
  if(!Array.isArray(images)||!images.length||typeof add!=='function'||typeof read!=='function'||typeof exists!=='function')
    throw Error('Invalid Eagle import dependencies');
  if(!Number.isInteger(batchSize)||batchSize<1||batchSize>25)throw Error('Unsafe batch size');
  const seen=new Set(),records=[],returnedIds=[],issues=[],groups=[];
  for(const image of images){
    if(!image.name||seen.has(image.name))throw Error('Duplicate/invalid planned image name');
    seen.add(image.name);
  }
  for(let start=0;start<images.length;start+=batchSize){
    const group=images.slice(start,start+batchSize);
    const batch={index:groups.length+1,start,count:group.length,
      names:group.map(x=>x.name),status:'submitting',ids:[],issues:[]};
    groups.push(batch);await record(structuredClone(batch));
    // Non-idempotent action: failure after this call must be inspected, not retried.
    const submitted=await add(group.map(x=>({
      source:{type:'url',url:x.url,website:x.website},name:x.name,
      ...(folderIds?{folders:[folderIds[x.category]]}:{})
    })));
    const rows=Array.isArray(submitted)?submitted:(submitted?.items||[]);
    batch.ids=[...new Set(rows.map(x=>x?.itemId||x?.id).filter(Boolean))];
    returnedIds.push(...batch.ids);
    batch.status='acknowledged';await record(structuredClone(batch));
    const matched=await verifyEagleReadback(group,rows,read,{delays});
    batch.readbackAttempts=matched.attempts;
    const reuse=resolveReused?await resolveReused({
      group,submitted:rows,records:matched.records,unverified:matched.records.filter(x=>!x.verified),batchIndex:batch.index
    }):{resolved:[],unresolved:[]};
    const resolved=new Map((reuse.resolved||[]).map(x=>[x.name,x]));
    batch.reused=resolved.size;
    for(const original of matched.records){
      const result=resolved.get(original.name)||original;
      if(result.verified && !exists(result.filePath)){
        result.verified=false;result.materialStatus='missing_physical_file';
        batch.issues.push('Eagle material missing: '+result.name);
      }
      records.push(result);
    }
    const confirmed=[...resolved.values()].filter(x=>x.verified);
    batch.issues.push(...matched.issues.filter(x=>
      !confirmed.some(r=>x==='No uniquely named verified item for '+r.name||
        (r.eagleName!==r.name&&x==='item_get returned unexpected name '+r.eagleName)))
      .map(x=>'Eagle mapping: '+x));
    batch.issues.push(...(reuse.unresolved||[]).map(x=>
      'Eagle reuse unresolved: '+x.name+' '+x.reason));
    issues.push(...batch.issues);
    batch.status=batch.issues.length||matched.records.some(x=>!x.verified&&!resolved.has(x.name))?'partial':'verified';
    // Once any part of a batch is uncertain, never submit later batches in the same run.
    // Keep all logical slots in the receipt, marking future slots as NOT attempted.
    if(batch.status!=='verified'){
      batch.halted=true;
      batch.unsubmitted=images.length-(start+group.length);
      records.push(...images.slice(start+group.length).map(x=>({...x,verified:false,
        submissionStatus:'not_submitted_due_to_prior_uncertain_batch'})));
    }
    await record(structuredClone(batch));
    if(batch.halted)break;
  }
  return {records,returnedIds,issues,groups,readbackAttempts:groups.reduce((n,x)=>n+(x.readbackAttempts||0),0)};
}
