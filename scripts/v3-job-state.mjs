// Durable V3 execution ledger. No automatic replay of an uncertain Eagle write.
import {openSync,closeSync,readFileSync,writeFileSync,existsSync,mkdirSync,renameSync,appendFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

export const V3_STATES=Object.freeze(['planned','prefetched','matched','reuse_link_intent',
  'import_intent','import_acknowledged','verified','needs_read_only_review']);
const allowed={
  planned:['prefetched','needs_read_only_review'],
  prefetched:['matched','reuse_link_intent','import_intent','needs_read_only_review'],
  matched:['reuse_link_intent','verified','needs_read_only_review'],
  reuse_link_intent:['verified','needs_read_only_review'],
  import_intent:['import_acknowledged','verified','needs_read_only_review'],
  import_acknowledged:['verified','needs_read_only_review'],
  verified:[],needs_read_only_review:['verified']
};

export function nextState(current,next){
  if(!V3_STATES.includes(current)||!V3_STATES.includes(next))throw Error('Invalid V3 state');
  if(!allowed[current].includes(next))throw Error('Unsafe V3 state transition: '+current+' -> '+next);
  return next;
}
export function maySubmitSlot(slot){
  return !!(slot&&slot.state==='prefetched'&&!slot.submitIntentRecorded&&
    !slot.uncertain&&slot.itemId==null);
}
export function needsOnlyReadback(slot){
  return !!slot&&['import_intent','import_acknowledged','reuse_link_intent','needs_read_only_review'].includes(slot.state);
}

export function createJob({productId,url,slots,libraryPath}){
  if(!/^\d{8,16}$/.test(productId)||!url?.startsWith('https://detail.tmall.com/item.htm')||
     !Array.isArray(slots)||!slots.length||!libraryPath)throw Error('Invalid V3 job identity');
  const keys=new Set();
  const plan=slots.map(slot=>{
    if(!['main','detail'].includes(slot.category)||!Number.isInteger(slot.order)||slot.order<1||
       typeof slot.name!=='string'||typeof slot.url!=='string')
      throw Error('Invalid V3 job slot');
    const key=slot.category+':'+slot.order;
    if(keys.has(key))throw Error('Duplicate V3 slot '+key);
    keys.add(key);
    return {...slot,state:'planned',itemId:null,submitIntentRecorded:false};
  });
  return {schemaVersion:1,productId,url,libraryPath,createdAt:new Date().toISOString(),
    updatedAt:new Date().toISOString(),state:'planned',slots:plan,events:0};
}
export function jobFile(root,id) {
  if(!/^\d{8,16}$/.test(String(id)))throw Error('Invalid product ID');
  return join(root,'data','v3-jobs',id+'.json');
}
export function loadJob(root,id){const file=jobFile(root,id);return existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null}
export function createStoredJob(root,job){
  const file=jobFile(root,job.productId);
  mkdirSync(dirname(file),{recursive:true});
  writeFileSync(file,JSON.stringify(job,null,2)+'\n',{flag:'wx'});
  return file;
}
export function recordJobEvent(root,job,{slotKey=null,state,event,metadata={}}){
  if(!job||!/^\d{8,16}$/.test(job.productId)||!event)throw Error('Invalid job event');
  const slot=slotKey?job.slots.find(x=>x.category+':'+x.order===slotKey):null;
  if(slotKey&&!slot)throw Error('Unknown V3 job slot');
  if(state&&slot){
    nextState(slot.state,state);
    slot.state=state;
    if(state==='import_intent')slot.submitIntentRecorded=true;
  }
  if(slot&&metadata)Object.assign(slot,metadata);
  job.events++;
  job.updatedAt=new Date().toISOString();
  const dir=dirname(jobFile(root,job.productId));
  mkdirSync(dir,{recursive:true});
  // Append intent first; if a subsequent snapshot write fails, the recovery log still exists.
  const log=join(dir,job.productId+'.events.jsonl');
  appendFileSync(log,JSON.stringify({id:randomUUID(),at:job.updatedAt,slotKey,state,event,metadata})+'\n','utf8');
  const file=jobFile(root,job.productId),tmp=file+'.'+randomUUID().slice(0,8)+'.tmp';
  writeFileSync(tmp,JSON.stringify(job,null,2)+'\n',{flag:'wx'});
  renameSync(tmp,file);
  return job;
}

// Restarting a job is only possible when the durable journal proves zero
// import or folder-link intentions, and the sole failure was a pre-write guard.
export function assertNoWriteResume(root,job,images,libraryPath,url){
  if(!job||job.schemaVersion!==1||job.libraryPath?.toLowerCase()!==libraryPath?.toLowerCase()||
     job.url!==url||!Array.isArray(images)||job.slots.length!==images.length)
    throw Error('V3 resume identity/source mismatch');
  const eventsPath=join(root,'data','v3-jobs',job.productId+'.events.jsonl');
  if(!existsSync(eventsPath))throw Error('Missing V3 durable event ledger');
  const events=readFileSync(eventsPath,'utf8').trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  if(events.length!==job.events)throw Error('V3 event ledger/snapshot count mismatch');
  if(events.some(x=>['import_intent','import_acknowledged','reuse_link_intent','verified'].includes(x.state)||
       /eagle_folder_link_submitting|single_eagle_import_submitting|single_eagle_import_acknowledged|single_eagle_import_verified/.test(x.event||'')))
    throw Error('V3 resume blocked: Eagle write intent exists, read-only reconciliation required');
  for(let i=0;i<job.slots.length;i++){
    const slot=job.slots[i],original=images[i];
    if(slot.category!==original.category||slot.order!==original.order||
       slot.name!==original.name||slot.url!==original.url||
       slot.submitIntentRecorded||slot.itemId!==null||
       !['planned','prefetched','needs_read_only_review'].includes(slot.state))
      throw Error('V3 resume slot is not an unsubmitted original');
    if(slot.state==='needs_read_only_review'&&![
      'Eagle library changed since fingerprint indexing; safely stop before any new item_add',
      'CDN returned a different file representation'
    ].some(s=>String(slot.error||'').includes(s)))
      throw Error('V3 resume has an unrecognized failed slot; never reset uncertain state');
  }
  return {status:'resume_no_eagle_writes_proven',slots:job.slots.length,events:events.length};
}

export function acquireLibraryLock(root,libraryPath){
  const key=createHash('sha256').update(libraryPath.toLowerCase()).digest('hex').slice(0,20);
  const dir=join(root,'data','v3-locks'),file=join(dir,key+'.lock');
  mkdirSync(dir,{recursive:true});
  let fd;
  try{fd=openSync(file,'wx')}catch(e){
    if(e.code==='EEXIST')throw Error('Eagle library V3 lock already exists; verify owner before recovery');
    throw e;
  }
  const entry={pid:process.pid,startedAt:new Date().toISOString(),libraryPath,nonce:randomUUID()};
  try{writeFileSync(fd,JSON.stringify(entry,null,2)+'\n','utf8');closeSync(fd)}catch(e){
    try{closeSync(fd)}catch{}
    throw e;
  }
  let released=false;
  return ()=>{
    if(released)return;
    const live=JSON.parse(readFileSync(file,'utf8'));
    if(live.nonce!==entry.nonce)throw Error('V3 library lock ownership changed');
    const archive=join(dir,'history');mkdirSync(archive,{recursive:true});
    renameSync(file,join(archive,key+'-'+entry.nonce+'.lock'));
    released=true;
  };
}
