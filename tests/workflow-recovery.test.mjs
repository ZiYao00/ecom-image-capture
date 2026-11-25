import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {acquireWorkflowLock} from '../scripts/workflow-lock.mjs';
import {inspectLock,archiveStaleLock} from '../scripts/lock-health.mjs';
import {runRecoveryWorkflow} from '../scripts/recover-product.mjs';
const root=()=>mkdtempSync(join(tmpdir(),'ecom-workflow-test-'));
test('workflow coordinator serializes index, capture and recovery workers',()=>{
 const dir=root(),env={};
 const parent=acquireWorkflowLock(dir,{coordinator:true,env});
 try{
  assert.equal(inspectLock(dir,'workflow').status,'active');
  assert.throws(()=>acquireWorkflowLock(dir,{env:{}}),/workflow is active/);
  assert.throws(()=>acquireWorkflowLock(dir,{env:{ECOM_WORKFLOW_LEASE:'invalid'}}),/stale or invalid/);
  const nested=acquireWorkflowLock(dir,{coordinator:true,env});
  assert.equal(nested.delegated,true);
  const worker=acquireWorkflowLock(dir,{env});
  assert.equal(inspectLock(dir,'workflow-child').status,'active');
  assert.throws(()=>acquireWorkflowLock(dir,{env}),/child or uncertain/);
  assert.throws(()=>archiveStaleLock(dir,'workflow'),/child first/);
  worker.release();nested.release();
  const next=acquireWorkflowLock(dir,{env});next.release();
 }finally{parent.release();}
 assert.equal(inspectLock(dir,'workflow').status,'absent');
 assert.equal(inspectLock(dir,'workflow-child').status,'absent');
 assert.equal(env.ECOM_WORKFLOW_LEASE,undefined);
});
test('unknown child outcome retains workflow lock and prevents new writes',()=>{
 const dir=root(),env={},parent=acquireWorkflowLock(dir,{coordinator:true,env});
 const nested=acquireWorkflowLock(dir,{coordinator:true,env});
 nested.markUncertain('simulated timeout');
 assert.throws(()=>acquireWorkflowLock(dir,{env}),/uncertain-operation/);
 parent.release();
 assert.equal(inspectLock(dir,'workflow').status,'active');
 assert.ok(existsSync(join(dir,'data','locks','workflow.lock','review.json')));
 assert.throws(()=>acquireWorkflowLock(dir,{env:{}}),/workflow is active/);
});
const ok=stage=>({ok:true,result:{status:stage==='index'?'index_ready':stage==='check'?'ready_partial_recovery':'complete',registryWorkflowAfter:'complete'}});
test('recovery coordinator refreshes read-only drift once then applies exactly once and verifies',()=>{
 const calls=[];let checks=0;
 const result=runRecoveryWorkflow({mode:'--apply',run:stage=>{
  calls.push(stage);
  if(stage==='check'&&++checks===1)return{ok:false,error:'Eagle library changed since fingerprint indexing; safely stop before any new item_add'};
  return ok(stage);
 }});
 assert.equal(result.status,'complete');
 assert.deepEqual(calls,['index','check','index','check','apply','verify-check','verify-apply']);
});
test('recovery coordinator never retries an uncertain write or marks registry complete',()=>{
 const calls=[];
 const result=runRecoveryWorkflow({mode:'--apply',run:stage=>{
  calls.push(stage);return stage==='apply'?{ok:false,error:'timeout',uncertainProcess:true}:ok(stage);
 }});
 assert.equal(result.status,'needs_read_only_review');assert.equal(result.uncertainProcess,true);
 assert.deepEqual(calls,['index','check','apply']);
});
test('recovery check and already completed product never enter apply',()=>{
 const calls=[];const run=stage=>{calls.push(stage);return ok(stage);};
 assert.equal(runRecoveryWorkflow({mode:'--check',run}).status,'ready_partial_recovery');
 assert.deepEqual(calls,['index','check']);calls.length=0;
 assert.equal(runRecoveryWorkflow({mode:'--apply',completed:true,run}).status,'already_complete');
 assert.deepEqual(calls,['verify-check']);
});
test('recovery refuses ambiguous protected positions without retrying or writing',()=>{
 const calls=[];
 const r=runRecoveryWorkflow({mode:'--apply',run:stage=>{
  calls.push(stage);return stage==='check'?{ok:false,error:'Submitted slot requires one exact existing target-folder match'}:ok(stage);
 }});
 assert.equal(r.status,'needs_read_only_review');assert.deepEqual(calls,['index','check']);
});

test('workflow lease is accepted by a real child process and released for the next operation',()=>{
 const dir=root(),env={...process.env};delete env.ECOM_WORKFLOW_LEASE;
 const parent=acquireWorkflowLock(dir,{coordinator:true,env});
 try{
  const moduleUrl=new URL('../scripts/workflow-lock.mjs',import.meta.url).href;
  const source='import {holdWorkflowLock} from '+JSON.stringify(moduleUrl)+';const lock=holdWorkflowLock('+JSON.stringify(dir)+');console.log(JSON.stringify({delegated:lock.delegated}));';
  const child=spawnSync(process.execPath,['--input-type=module','-e',source],{env,encoding:'utf8',timeout:15000,windowsHide:true});
  assert.equal(child.status,0,child.stderr);
  assert.equal(JSON.parse(child.stdout).delegated,true);
  assert.equal(inspectLock(dir,'workflow-child').status,'absent');
  assert.equal(inspectLock(dir,'workflow').status,'active');
 }finally{parent.release();}
 assert.equal(inspectLock(dir,'workflow').status,'absent');
});
