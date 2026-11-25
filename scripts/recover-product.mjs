#!/usr/bin/env node
// Explicit recovery-only coordinator. No global V3 config change and no replay
// of uncertain item_add. Both single-product and V3 batch recovery use this path.
import {readFileSync,existsSync,mkdirSync,appendFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {canonicalProductUrl,readRegistry} from './capture-store.mjs';
import {loadJob} from './v3-job-state.mjs';
import {buildLegacyRecoveryPlan,receiptDigest} from './v3-recovery-core.mjs';
import {holdWorkflowLock} from './workflow-lock.mjs';
import {assertIndustryMigrationNotActive} from './eagle-industry-move.mjs';

const drift=r=>!r.uncertainProcess&&/library changed since fingerprint indexing|inventory differs|inventory identity or physical metadata changed|inventory changed during fingerprint refresh/i.test(r.error||'');
export function runRecoveryWorkflow({mode,completed=false,run}){
  const steps=[];
  const step=(stage)=>{
    const result=run(stage);
    steps.push({stage,status:result.ok?'passed':'blocked',...(result.error?{error:result.error}:{}),...(result.uncertainProcess?{uncertainProcess:true}:{})});
    return result;
  };
  const stopped=(stage,result)=>({status:'needs_read_only_review',stage,steps,error:result.error||'Stage did not verify',noAutomaticRetry:true,uncertainProcess:!!result.uncertainProcess});
  if(completed){
    const live=step('verify-check');
    return live.ok&&live.result?.status==='complete'
      ?{status:'already_complete',steps,verification:live.result,noReimport:true}
      :stopped('verify-check',live);
  }
  let index=step('index');
  if(!index.ok||index.result?.status!=='index_ready')return stopped('index',index);
  let pre=step('check');
  // A read-only drift check may refresh once. No write-stage retry is allowed.
  if(!pre.ok&&drift(pre)){
    index=step('index');
    if(!index.ok||index.result?.status!=='index_ready')return stopped('index',index);
    pre=step('check');
  }
  if(!pre.ok||pre.result?.status!=='ready_partial_recovery')return stopped('check',pre);
  if(mode==='--check')return {status:'ready_partial_recovery',steps,preflight:pre.result,eagleWrites:0};
  const applied=step('apply');
  if(!applied.ok||applied.result?.status!=='complete')return stopped('apply',applied);
  const live=step('verify-check');
  if(!live.ok||live.result?.status!=='complete')return stopped('verify-check',live);
  const saved=step('verify-apply');
  if(!saved.ok||saved.result?.status!=='complete'||saved.result?.registryWorkflowAfter!=='complete')
    return stopped('verify-apply',saved);
  return {status:'complete',steps,preflight:pre.result,recovery:applied.result,verification:saved.result,noReimport:true};
}

async function main(){
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const [mode,id,sourceUrl]=process.argv.slice(2);
  if(!['--check','--apply'].includes(mode)||!/^\d{8,16}$/.test(id||'')||process.argv.length>5)
    throw Error('Usage: ecom recover --check|--apply <productId> [originalTmallUrl]');
  const receiptFile=join(root,'data','runs','stable-'+id,'receipt.json');
  if(!existsSync(receiptFile))throw Error('No original receipt; recovery must not create a new capture');
  const workflow=holdWorkflowLock(root,{coordinator:true});
  assertIndustryMigrationNotActive(root);
  const original=readFileSync(receiptFile),receipt=JSON.parse(original.toString('utf8'));
  const digest=receiptDigest(original),registry=readRegistry(root).products[id],job=loadJob(root,id);
  if(receipt.productId!==id||!Array.isArray(receipt.images)||!receipt.images.length||!registry)
    throw Error('Original receipt/registry identity incomplete');
  const source=sourceUrl?canonicalProductUrl(sourceUrl):null;
  if(source&&(source.productId!==id||String(source.skuId||'')!==String(receipt.skuId||'')))
    throw Error('Original product or SKU does not match');
  if(registry.skuId&&String(registry.skuId)!==String(receipt.skuId||''))
    throw Error('Registry SKU conflicts with original receipt');
  const completed=registry.status==='success'&&registry.workflowStatus==='complete';
  if(!completed){
    if(Number(process.versions.node.split('.')[0])<24)throw Error('Recovery-only path requires Node >=24; default V2 capture is unchanged');
    if(receipt.captureVersion==='v3.1-experimental'){if(!job)throw Error('V3 durable job missing');}
    else {buildLegacyRecoveryPlan(receipt,original);if(!sourceUrl&&!job)throw Error('First V2 recovery requires original full URL');}
    if(job&&source&&job.url!==source.url)throw Error('Recovery URL conflicts with durable job identity');
  }
  const folder=join(root,'data','reconciliations');mkdirSync(folder,{recursive:true});
  const journal=join(folder,'recovery-coordinator-'+id+'-'+Date.now()+'-'+randomUUID().slice(0,8)+'.jsonl');
  writeFileSync(journal,'',{flag:'wx'});
  const event=(stage,metadata={})=>appendFileSync(journal,JSON.stringify({at:new Date().toISOString(),stage,productId:id,receiptSha256:digest,...metadata})+'\n');
  const recoveryArgs=(m)=>['v3-resume-partial.mjs','--recovery-only',m,id,...(sourceUrl?[sourceUrl]:[])];
  const commands={
    index:{args:['v3-index.mjs','--build'],timeout:300000},
    check:{args:recoveryArgs('--check'),timeout:180000},
    apply:{args:recoveryArgs('--apply'),timeout:840000},
    'verify-check':{args:['verify-live-product.mjs',id,'--check'],timeout:180000},
    'verify-apply':{args:['verify-live-product.mjs',id,'--apply'],timeout:180000}
  };
  const run=stage=>{
    const c=commands[stage];
    if(receiptDigest(readFileSync(receiptFile))!==digest)throw Error('Original receipt changed; stop without replay');
    event(stage+'_starting');
    const p=spawnSync(process.execPath,[join(root,'scripts',c.args[0]),...c.args.slice(1)],{
      cwd:root,encoding:'utf8',windowsHide:true,timeout:c.timeout,maxBuffer:10*1024*1024});
    let result=null;try{result=JSON.parse((p.stdout||'').trim())}catch{}
    const error=String(p.error?.message||result?.error||p.stderr||'').slice(0,1500);
    const uncertainProcess=!!p.error||p.status===null||/ETIMEDOUT|timeout.*spawn|spawn.*timeout/i.test(error);
    if(uncertainProcess)workflow.markUncertain(error||'Recovery child process outcome unknown');
    const response={ok:!p.error&&p.status===0&&!!result,result,error,uncertainProcess};
    event(stage+'_finished',{exitCode:p.status,ok:response.ok,status:result?.status,error:error||undefined,uncertainProcess});
    return response;
  };
  const report=runRecoveryWorkflow({mode,completed,run});
  const originalReceiptUnchanged=receiptDigest(readFileSync(receiptFile))===digest;
  if(!originalReceiptUnchanged)throw Error('Original receipt changed unexpectedly; preserve journal for review');
  event('finished',{status:report.status,originalReceiptUnchanged});
  console.log(JSON.stringify({...report,productId:id,mode,journal,originalReceiptUnchanged,defaultEngineUnchanged:true},null,2));
  if(!['complete','already_complete','ready_partial_recovery'].includes(report.status))process.exitCode=2;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await main()}catch(error){
    console.log(JSON.stringify({status:'needs_read_only_review',error:String(error.message||error),noAutomaticRetry:true},null,2));
    process.exitCode=2;
  }
}
