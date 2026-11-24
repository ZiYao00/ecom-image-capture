#!/usr/bin/env node
// Serial multi-URL queue. No duplicate imports; existing receipts are never resubmitted.
// Each planned/invoking/completed step is persisted. Shared or uncertain failures halt subsequent writes.
import {readFileSync,writeFileSync,existsSync,mkdirSync,renameSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readRegistry} from './capture-store.mjs';
import {parseBatchUrls,classifyBatchProduct,shouldHaltBatchAfterAttempt} from './batch-core.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [mode,file]=process.argv.slice(2);
if(!['--check','--apply'].includes(mode)||!file||process.argv.length!==4)
 throw Error('Usage: node scripts/batch-capture.mjs --check|--apply <urls.txt|urls.json>');
const fullPath=resolve(file);
if(!existsSync(fullPath))throw Error('Batch input does not exist: '+fullPath);
const entries=parseBatchUrls(readFileSync(fullPath,'utf8'));
const receiptExists=id=>existsSync(join(root,'data','runs','stable-'+id,'receipt.json'));
const plan=()=>entries.map(x=>{
 const old=readRegistry(root).products[x.productId]||null;
 const disposition=classifyBatchProduct(x,old,receiptExists(x.productId));
 return {index:x.index,productId:x.productId,skuId:x.skuId,disposition,registryStatus:old?.status||null,
   existingWorkflow:old?.workflowStatus||null};
});
const planned=plan();
if(mode==='--check'){
 console.log(JSON.stringify({status:'ready',operation:'batch-check',batchCount:entries.length,
  newCount:planned.filter(x=>x.disposition==='ready_for_new_capture').length,items:planned,changed:false},null,2));
 process.exit(0);
}
const folder=join(root,'data','batches');mkdirSync(folder,{recursive:true});
const fileName=join(folder,'batch-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8)+'.json');
const journal={status:'running',createdAt:new Date().toISOString(),inputFile:fullPath,
  items:planned.map(x=>({...x,status:'planned',startedAt:null,finishedAt:null,error:null}))};
const save=()=>{
 const tmp=fileName+'.'+randomUUID().slice(0,6)+'.tmp';
 writeFileSync(tmp,JSON.stringify(journal,null,2)+'\n',{flag:'wx'});
 renameSync(tmp,fileName);
};
save();
const run=(cmd,args,{timeout=420000}={})=>{
 const child=spawnSync(process.execPath,[join(root,'scripts',cmd),...args],
  {cwd:root,encoding:'utf8',windowsHide:true,timeout,maxBuffer:5*1024*1024});
 let obj=null;try{obj=JSON.parse((child.stdout||'').trim())}catch{}
 return {ok:!child.error&&child.status===0,code:child.status,
  data:obj,error:String(child.error?.message||child.stderr||'').slice(0,800)};
};
const summary=[];
let halt=null;
for(const entry of entries){
 const row=journal.items[entry.index-1];
 if(halt){
  row.status='not_started_due_to_batch_halt';row.error='Blocked by '+halt.productId;row.finishedAt=new Date().toISOString();save();
  summary.push({id:entry.productId,status:row.status});continue;
 }
 // Check current registry again, since an earlier step or user may have changed it.
 const reg=readRegistry(root).products[entry.productId]||null;
 const state=classifyBatchProduct(entry,reg,receiptExists(entry.productId));
 if(state!=='ready_for_new_capture'){
  row.status=state;row.finishedAt=new Date().toISOString();save();
  summary.push({id:entry.productId,status:row.status});continue;
 }
 row.status='invoking_capture';row.startedAt=new Date().toISOString();save();
 // Never repeat this call, even if Chrome/Eagle reports an uncertain exit.
 const attempt=run('ecom.mjs',['capture',entry.fullUrl],{timeout:440000});
 row.captureExitCode=attempt.code;
 row.captureResult=attempt.data?.result?{
   status:attempt.data.result.status,workflowStatus:attempt.data.result.workflowStatus,
   main:attempt.data.result.main,detail:attempt.data.result.detail,
   verified:attempt.data.result.verified,stitchStatus:attempt.data.result.stitch?.status,
   missing:attempt.data.result.archive?.missing||[],
   errors:(attempt.data.result.errors||[]).slice(0,8)}:null;
 row.error=attempt.ok?null:(attempt.error||attempt.data?.error||attempt.data?.status||'capture failed');
 if(!attempt.ok||attempt.data?.result?.workflowStatus!=='complete'){
  row.status=attempt.data?.result?.status==='incomplete_before_eagle'
    ?'needs_browser_safe_resume':'needs_read_only_recovery';
 }else{
  // Independent, non-mutating re-read of Eagle files and long JPEG.
  const archive=run('ecom.mjs',['archive',entry.productId,'--check'],{timeout:95000});
  const long=run('ecom.mjs',['stitch-eagle',entry.productId,'750','--check'],{timeout:120000});
  row.archiveStatus=archive.data?.result?.status||null;
  row.longStatus=long.data?.result?.status||null;
  row.status=archive.ok&&archive.data?.result?.status==='complete'&&long.ok&&long.data?.result?.status==='already_complete'
    ?'complete':'needs_read_only_recovery';
 }
 let receipt=null;
 if(row.status!=='complete')try{receipt=JSON.parse(readFileSync(join(root,'data','runs','stable-'+entry.productId,'receipt.json'),'utf8'))}catch{}
 if(shouldHaltBatchAfterAttempt({status:row.status,result:attempt.data?.result,receipt})){
  halt={productId:entry.productId,status:row.status,error:row.error||'Independent verification failed'};
  journal.halt=halt;
 }
 row.finishedAt=new Date().toISOString();save();
 summary.push({id:entry.productId,status:row.status,main:row.captureResult?.main||0,
   detail:row.captureResult?.detail||0,verified:row.captureResult?.verified||0});
}
journal.status=summary.every(x=>['complete','skipped_existing_complete'].includes(x.status))
  ?'complete':'partial';
journal.completedAt=new Date().toISOString();
journal.summary=summary;
save();
console.log(JSON.stringify({status:journal.status,operation:'batch-capture',inputCount:entries.length,
  newlyComplete:summary.filter(x=>x.status==='complete').length,
  existingComplete:summary.filter(x=>x.status==='skipped_existing_complete').length,
  needsReview:summary.filter(x=>!['complete','skipped_existing_complete'].includes(x.status)).length,
  summary,halt,journal:fileName,noAutomaticReimport:true},null,2));
if(journal.status!=='complete')process.exitCode=2;
