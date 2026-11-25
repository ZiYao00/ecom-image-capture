#!/usr/bin/env node
// Serial queue: persisted intent, explicit engine, independent verification, no replay of unknown writes.
import {readFileSync,writeFileSync,existsSync,mkdirSync,renameSync,readdirSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readRegistry} from './capture-store.mjs';
import {parseBatchUrls,parseBatchOptions,classifyBatchProduct,collectBatchBarriers,runBatchQueue,BATCH_BUDGETS} from './batch-core.mjs';
import {acquireLibraryLock,loadJob} from './v3-job-state.mjs';
import {holdWorkflowLock} from './workflow-lock.mjs';
import {inspectLock} from './lock-health.mjs';
import {eagleArchiveRpc} from './eagle-archive.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const {file,mode,engine}=parseBatchOptions(process.argv.slice(2));
const configFile=name=>{const p=join(root,'config',name);return existsSync(p)?JSON.parse(readFileSync(p,'utf8')):{}};
const cfg={...configFile('local.example.json'),...configFile('local.json')};
const fullPath=resolve(file),source=readFileSync(fullPath,'utf8');
const entries=parseBatchUrls(source);
const inputSha256=createHash('sha256').update(source).digest('hex');
const folder=join(root,'data','batches'),jobsFolder=join(root,'data','v3-jobs');
const engineEnabled=engine==='v2'||(cfg.v3Experimental===true&&Number(process.versions.node.split('.')[0])>=24);
const readReceipt=id=>{
 const f=join(root,'data','runs','stable-'+id,'receipt.json');
 if(!existsSync(f))return null;
 const r=JSON.parse(readFileSync(f,'utf8'));if(r.productId!==id)throw Error('Receipt identity mismatch: '+id);
 return r;
};
const classify=entry=>{
 const r=readReceipt(entry.productId),old=readRegistry(root).products[entry.productId]||null;
 const jobExists=existsSync(join(jobsFolder,entry.productId+'.json'))||existsSync(join(jobsFolder,entry.productId+'.events.jsonl'));
 return classifyBatchProduct(entry,old,!!r,r,jobExists);
};
function getBarriers(excludeFile=null){
 const journals=existsSync(folder)?readdirSync(folder).filter(f=>/^batch-.*\.json$/.test(f)).map(f=>join(folder,f)).filter(f=>f!==excludeFile).map(f=>JSON.parse(readFileSync(f,'utf8'))):[];
 const jobs=existsSync(jobsFolder)?readdirSync(jobsFolder).filter(f=>/^\d{8,16}\.json$/.test(f)).map(f=>JSON.parse(readFileSync(join(jobsFolder,f),'utf8'))):[];
 // An orphan ledger must never silently become a fresh capture.
 if(existsSync(jobsFolder))for(const f of readdirSync(jobsFolder).filter(f=>/^\d{8,16}\.events\.jsonl$/.test(f))){
   const id=f.split('.')[0];if(!jobs.some(j=>j.productId===id))jobs.push({productId:id,state:'orphan',slots:[{state:'unknown'}]});
 }
 const blocked=collectBatchBarriers({journals,jobs,products:readRegistry(root).products});
 const locks=join(root,'data','locks');
 if(existsSync(locks))for(const file of readdirSync(locks)){
   const m=/^product-(\d{8,16})\.lock$/.exec(file);if(!m)continue;
   const state=inspectLock(root,m[1]);
   if(['active','unknown'].includes(state.status)&&!blocked.some(x=>x.productId===m[1]))
      blocked.push({productId:m[1],reason:'product_process_'+state.status});
 }
 return blocked;
}
const plan=()=>entries.map(x=>({index:x.index,productId:x.productId,skuId:x.skuId,disposition:classify(x)}));
const blockers=getBarriers();
if(mode==='--check'){
 const planned=plan();
 const externalBlockers=blockers.filter(x=>!entries.some(e=>e.productId===x.productId));
 const identityConflict=planned.some(x=>['existing_sku_conflict','existing_sku_unknown','orphan_job_needs_review','skipped_registry_without_receipt'].includes(x.disposition));
 const reviewRequired=externalBlockers.length>0||identityConflict;
 console.log(JSON.stringify({status:!engineEnabled?'engine_disabled':reviewRequired?'needs_review':'ready',operation:'batch-check',engine,engineEnabled,
  inputSha256,batchCount:entries.length,newCount:planned.filter(x=>x.disposition==='ready_for_new_capture').length,
  blockers,items:planned,changed:false},null,2));
 if(!engineEnabled)process.exitCode=10;
 else if(reviewRequired)process.exitCode=2;
}else if(!engineEnabled){
 console.log(JSON.stringify({status:'engine_disabled',engine,changed:false},null,2));process.exitCode=10;
}else{
 // Batch coordination uses a separate lock namespace from per-image V3 writes.
 // A stale batch lock is never silently removed; a previous unknown process must be inspected.
 const app=await eagleArchiveRpc(cfg.eagleMcpUrl,'get_app_info',{});
 if(!app?.libraryPath)throw Error('No current Eagle library identity');
 const workflow=holdWorkflowLock(root,{coordinator:true});
  const release=acquireLibraryLock(root,'batch:'+app.libraryPath);
 try{
 const planned=plan();
 mkdirSync(folder,{recursive:true});
 const fileName=join(folder,'batch-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8)+'.json');
 const journal={schemaVersion:2,status:'running',engine,libraryPath:app.libraryPath,createdAt:new Date().toISOString(),
   inputFile:fullPath,inputSha256,items:planned.map(x=>({...x,status:'planned',startedAt:null,finishedAt:null,error:null}))};
 const save=()=>{
  const tmp=fileName+'.'+randomUUID().slice(0,6)+'.tmp';
  writeFileSync(tmp,JSON.stringify(journal,null,2)+'\n',{flag:'wx'});renameSync(tmp,fileName);
 };
 save();
 const call=(args,timeout)=>{
  const child=spawnSync(process.execPath,[join(root,'scripts','ecom.mjs'),...args],{
   cwd:root,encoding:'utf8',windowsHide:true,timeout,maxBuffer:8*1024*1024});
  let obj=null;try{obj=JSON.parse((child.stdout||'').trim())}catch{}
  const error=String(child.error?.message||obj?.error||child.stderr||'').slice(0,1200);
  const uncertainProcess=!!child.error||child.status===null||obj?.exitCode===null||/ETIMEDOUT|timeout.*spawn|spawn.*timeout/i.test(error);
  if(uncertainProcess)workflow.markUncertain(error||'Batch child exit uncertain');
   return {ok:!child.error&&child.status===0,code:child.status,result:obj?.result??null,error,uncertainProcess};
 };
 const verifyDelivery=(entry,{apply=false}={})=>{
  const id=entry.productId;
  const checked=call(['verify-live',id,'--check'],BATCH_BUDGETS.read);
  if(!checked.ok||checked.result?.status!=='complete')return {...checked,ok:false};
  if(!apply)return checked;
  const updated=call(['verify-live',id,'--apply'],BATCH_BUDGETS.read);
  return {...updated,ok:updated.ok&&updated.result?.status==='complete'&&updated.result?.registryWorkflowAfter==='complete'};
 };
 const canRecover=entry=>{
  const id=entry.productId,receipt=readReceipt(id),job=loadJob(root,id);
  if(!receipt||!receipt.images?.length||!receipt.folderIds?.main||!receipt.folderIds?.detail)return false;
  const lock=inspectLock(root,id);if(!['absent','stale'].includes(lock.status))return false;
  return receipt.captureVersion==='v3.1-experimental'?!!job:receipt.eagle==='partially_verified'&&!!receipt.eagleBatches?.length;
 };
 const refreshIndex=()=>{
  const result=call(['v3-index','--build'],BATCH_BUDGETS.index);
  return {...result,ok:result.ok&&result.result?.status==='index_ready'};
 };
 const run=(kind,entry)=>{
  const id=entry.productId;
  if(kind==='capture'){
   const result=call([engine==='v3'?'capture-v3':'capture',entry.fullUrl],BATCH_BUDGETS.capture);
   return {...result,ok:result.ok&&result.result?.workflowStatus==='complete',receipt:readReceipt(id)};
  }
  // A successful read-only check proves recovery is supported; never retry
  // the original capture or a failed recovery apply in the same batch.
  const applied=call(['recover','--apply',id,entry.fullUrl],BATCH_BUDGETS.recovery);
    return {...applied,ok:applied.ok&&['complete','already_complete'].includes(applied.result?.status),
      recovered:true,finalized:true,receipt:readReceipt(id)};
 };
 const saveRow=(entry,update)=>{
   const row=journal.items[entry.index-1];
   Object.assign(row,update);
   if(update.status?.startsWith('invoking_'))row.startedAt??=new Date().toISOString();
   else row.finishedAt=new Date().toISOString();
   save();
 };
 const {summary,halt}=runBatchQueue({entries,engine,classify,
  barriers:()=>getBarriers(fileName),run,saveRow,canRecover,refreshIndex,verifyDelivery,
  canAutoRecover:attempt=>!attempt.uncertainProcess&&attempt.code===2&&(attempt.result?.status==='incomplete'||attempt.result?.workflowStatus==='incomplete')});
 journal.halt=halt;
 journal.status=summary.every(x=>['complete','skipped_existing_complete'].includes(x.status))?'complete':'partial';
 journal.completedAt=new Date().toISOString();journal.summary=summary;save();
 console.log(JSON.stringify({status:journal.status,operation:'batch-capture',engine,inputSha256,inputCount:entries.length,
  newlyComplete:summary.filter(x=>x.status==='complete').length,
  existingComplete:summary.filter(x=>x.status==='skipped_existing_complete').length,
  needsReview:summary.filter(x=>!['complete','skipped_existing_complete'].includes(x.status)).length,
  summary,halt,journal:fileName,noAutomaticReimport:true},null,2));
 if(journal.status!=='complete')process.exitCode=2;
 }finally{release()}
}
