// Slot-level recovery: prove what was submitted, and never replay an uncertain write.
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {nextState} from './v3-job-state.mjs';
const key=x=>x.category+':'+x.order;
const sha=x=>/^[a-f0-9]{64}$/.test(x||'');
const eid=x=>/^[A-Za-z0-9_-]{8,64}$/.test(x||'');
export const receiptDigest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function buildLegacyRecoveryPlan(receipt,originalBytes){
  if(receipt.captureVersion||receipt.phase!=='incomplete'||receipt.eagle!=='partially_verified'||
     !/^\d{8,16}$/.test(receipt.productId||'')||!Array.isArray(receipt.images)||!receipt.images.length||
     !Array.isArray(receipt.eagleBatches)||!receipt.eagleBatches.length||receipt.directFallback?.length||
     !receipt.folderIds?.main||!receipt.folderIds?.detail)
    throw Error('Legacy receipt is not a supported halted V2 partial capture');
  const {images,eagleBatches}=receipt;
  let covered=0;const allIds=[];
  for(let i=0;i<eagleBatches.length;i++){
    const b=eagleBatches[i],last=i===eagleBatches.length-1;
    if(b.index!==i+1||b.start!==covered||!Number.isInteger(b.count)||b.count<1||b.count>8||
       covered+b.count>images.length||!['verified','partial'].includes(b.status)||
       !Array.isArray(b.names)||b.names.length!==b.count||
       !Array.isArray(b.ids)||b.ids.length!==b.count||b.ids.some(x=>!eid(x))||
       b.names.some((n,j)=>n!==images[covered+j]?.name)||
       (!last&&(b.status!=='verified'||b.halted))||
       (last&&(b.status!=='partial'||b.halted!==true||b.unsubmitted!==images.length-covered-b.count)))
      throw Error('Legacy batch evidence is incomplete or inconsistent; never guess unsubmitted slots');
    allIds.push(...b.ids);covered+=b.count;
  }
  const ids=[...new Set(allIds)].sort();
  if(JSON.stringify(ids)!==JSON.stringify([...(receipt.eagleReturnedItemIds||[])].sort())||covered>=images.length)
    throw Error('Legacy returned IDs or halted tail disagree with receipt');
  const slots=images.map((s,i)=>{
    if(i<covered){
      if(s.submissionStatus==='not_submitted_due_to_prior_uncertain_batch')throw Error('Submitted prefix incorrectly marked unsubmitted');
      if(s.verified===true){
        if(!eid(s.itemId)||!sha(s.sha256))throw Error('Verified legacy slot has no durable identity/hash');
        return {key:key(s),kind:'historical_verified',itemId:s.itemId,sha256:s.sha256};
      }
      return {key:key(s),kind:'historical_uncertain'};
    }
    if(s.submissionStatus!=='not_submitted_due_to_prior_uncertain_batch'||s.verified===true||s.itemId||s.acknowledged)
      throw Error('Legacy tail has no explicit zero-submission proof');
    return {key:key(s),kind:'unsubmitted'};
  });
  if(new Set(slots.map(x=>x.key)).size!==slots.length)throw Error('Duplicate legacy slot identity');
  for(const c of ['main','detail']){
    const group=images.filter(x=>x.category===c);
    if(!group.length||group.length!==receipt.selected?.[c]||
       group.some((x,i)=>x.order!==i+1||x.name!=='Tmall-'+receipt.productId+'-'+c+'-'+String(i+1).padStart(3,'0')))
      throw Error('Legacy receipt source order is inconsistent');
  }
  if(images.some(s=>!['main','detail'].includes(s.category)))throw Error('Invalid legacy image category');
  return {kind:'v2_halted_partial',receiptSha256:receiptDigest(originalBytes),slots};
}

const safeResets=new Set(['prewrite_guard_resumed_using_verified_cache','prewrite_guard_resumed_after_safe_prefetch','partial_prewrite_reset']);
const writeStates=new Set(['import_intent','import_acknowledged','reuse_link_intent']);
const requiredEventStates={
  single_eagle_import_submitting:'import_intent',
  single_eagle_import_acknowledged:'import_acknowledged',
  eagle_folder_link_submitting:'reuse_link_intent',
  single_eagle_import_verified:'verified',
  reuse_physical_verified:'verified',
  protected_item_verified:'verified'
};
export function inspectPartialJournal(root,job,images,libraryPath,url,legacyPlan=null){
  if(!job||job.schemaVersion!==1||job.url!==url||
     job.libraryPath?.toLowerCase()!==libraryPath?.toLowerCase()||
     job.slots?.length!==images.length||
     JSON.stringify(job.recovery||null)!==JSON.stringify(legacyPlan||null))
    throw Error('Partial recovery source/library/receipt identity mismatch');
  const log=join(root,'data','v3-jobs',job.productId+'.events.jsonl');
  const events=existsSync(log)?readFileSync(log,'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse):[];
  if(events.length!==job.events)throw Error('Partial recovery ledger/snapshot count mismatch');
  const proofs=new Map();
  for(let i=0;i<images.length;i++){
    const s=job.slots[i],original=images[i],k=key(s);
    if(s.category!==original.category||s.order!==original.order||s.name!==original.name||s.url!==original.url||proofs.has(k))
      throw Error('Partial recovery slot/source changed');
    proofs.set(k,{state:'planned',importIntent:false,linkIntent:false,verified:false,itemId:null,sha256:original.sha256||null});
  }
  for(const e of events){
    if(e.slotKey===null){
      if(e.state||e.metadata?.state!==undefined)throw Error('Unexpected job-level state transition');
      continue;
    }
    const p=proofs.get(e.slotKey);if(!p)throw Error('Unknown slot in partial recovery journal');
    if(requiredEventStates[e.event]&&e.state!==requiredEventStates[e.event])
      throw Error('Write/verification event has no matching durable state');
    if(e.state)nextState(p.state,e.state);
    if(e.state==='import_intent'||e.state==='reuse_link_intent'){
      if(p.importIntent||p.linkIntent||p.verified)throw Error('Repeated or conflicting Eagle write intent');
      if(e.state==='import_intent')p.importIntent=true;
      else p.linkIntent=true;
    }
    if(e.state==='import_acknowledged'&&!p.importIntent)throw Error('Acknowledgment without import intent');
    if(e.state==='verified')p.verified=true;
    if(e.state)p.state=e.state;
    if(e.metadata?.state!==undefined){
      if(!safeResets.has(e.event)||e.metadata.state!=='prefetched'||p.importIntent||p.linkIntent||p.verified)
        throw Error('Unsafe state reset in partial recovery journal');
      p.state='prefetched';
    }
    if(e.metadata&&Object.hasOwn(e.metadata,'itemId'))p.itemId=e.metadata.itemId;
    if(e.metadata?.sha256){
      if(p.sha256&&p.sha256!==e.metadata.sha256)throw Error('Historical slot digest changed');
      p.sha256=e.metadata.sha256;
    }
  }
  for(const s of job.slots){
    const p=proofs.get(key(s));
    if(s.state!==p.state||Boolean(s.submitIntentRecorded)!==p.importIntent||
       (s.itemId||null)!==(p.itemId||null)||(s.sha256||null)!==(p.sha256||null)||
       (p.verified&&s.state!=='verified')||(!p.verified&&s.state==='verified')||
       (writeStates.has(s.state)&&!p.importIntent&&!p.linkIntent))
      throw Error('Partial recovery snapshot diverges from durable slot events: '+s.name);
  }
  return proofs;
}
export function protectedSlots(images,legacyPlan=null,proofs=null){
  const out=new Map();
  for(const s of images){
    const k=key(s),old=legacyPlan?.slots.find(x=>x.key===k),p=proofs?.get(k);
    if(p?.verified){
      if(!eid(p.itemId)||!sha(p.sha256)|| (old?.itemId&&old.itemId!==p.itemId))
        throw Error('Previously verified slot lost identity: '+s.name);
      out.set(k,{kind:'verified',requiredId:p.itemId,expectedSha:p.sha256});continue;
    }
    if(old?.kind==='historical_verified'){
      out.set(k,{kind:old.kind,requiredId:old.itemId,expectedSha:old.sha256});continue;
    }
    if(p?.linkIntent){
      if(!eid(p.itemId)||!sha(p.sha256))throw Error('Prior link lacks identity: '+s.name);
      out.set(k,{kind:'link_intent',requiredId:p.itemId,expectedSha:p.sha256});continue;
    }
    if(p?.importIntent){
      if(!sha(p.sha256))throw Error('Prior import lacks hash: '+s.name);
      out.set(k,{kind:'import_intent',preferredId:p.itemId,expectedSha:p.sha256});continue;
    }
    if(old?.kind==='historical_uncertain')out.set(k,{kind:old.kind});
  }
  return out;
}
export async function proveProtectedSlot({slot,proof,index,folderId,getById,libraryPath,verifyById,validateCandidate}){
  if(!sha(slot.sha256)||(proof.expectedSha&&proof.expectedSha!==slot.sha256))
    throw Error('Protected slot source hash differs from original: '+slot.name);
  const args={getById,libraryPath,expectedSha:slot.sha256,folderId,delays:[0,400,1000]};
  if(proof.requiredId){
    const found=await verifyById(proof.requiredId,args);
    if(!found)throw Error('Previously verified/link item no longer matches: '+slot.name);
    return found;
  }
  if(proof.preferredId){
    const found=await verifyById(proof.preferredId,args);
    if(found)return found;
  }
  const candidates=[];
  for(const candidate of index.lookup(slot.sha256)){
    const found=await validateCandidate(candidate,args);
    if(found?.folders?.includes(folderId))candidates.push(found);
  }
  if(candidates.length!==1)throw Error('Submitted slot requires one exact existing target-folder match: '+slot.name+' (found '+candidates.length+')');
  return candidates[0];
}
