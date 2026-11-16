import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,writeFileSync,mkdtempSync,readdirSync,readFileSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectLock,archiveStaleLock,lockPath} from '../scripts/lock-health.mjs';
import {acquireProductLock,withShortLock} from '../scripts/capture-store.mjs';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const fixtures=join(project,'data','.closeout-tests');
mkdirSync(fixtures,{recursive:true});
const prepare=()=>{const root=mkdtempSync(join(fixtures,'locks-'));mkdirSync(join(root,'data'));return root};
const stale=(root,key)=>{
 const folder=lockPath(root,key);
 mkdirSync(folder,{recursive:true});
 writeFileSync(join(folder,'owner.json'),JSON.stringify({
  token:randomUUID(),pid:42424242,startedAt:new Date(Date.now()-60000).toISOString()}));
 return folder;
};
const dead={minAgeMs:0,now:Date.now()+30000,checkPid:()=> 'dead'}; // Simulate an aged lock without relying on Windows timestamp granularity.

test('active product lock is never archived',()=>{
 const root=prepare(),unlock=acquireProductLock(root,'123456789012');
 try{
  assert.ok(['active','unknown'].includes(inspectLock(root,'123456789012').status));
  assert.throws(()=>archiveStaleLock(root,'123456789012',dead),/Refusing to archive/);
 }finally{unlock()}
 assert.equal(inspectLock(root,'123456789012').status,'absent');
});
test('missing or malformed owner metadata cannot be cleared',()=>{
 const root=prepare(),path=lockPath(root,'123456789012');
 mkdirSync(path,{recursive:true});
 assert.equal(inspectLock(root,'123456789012',dead).status,'unknown');
 assert.throws(()=>archiveStaleLock(root,'123456789012',dead),/Refusing to archive/);
 assert.ok(existsSync(path));
});
test('verified dead product lock is archived rather than deleted',()=>{
 const root=prepare(),key='123456789012',path=stale(root,key);
 assert.equal(inspectLock(root,key,dead).status,'stale');
 const result=archiveStaleLock(root,key,dead);
 assert.equal(result.status,'archived');
 assert.ok(existsSync(result.backup));
 assert.equal(existsSync(path),false);
 const record=JSON.parse(readFileSync(join(result.backup,'owner.json'),'utf8'));
 assert.equal(record.pid,42424242);
});
test('product acquisition can recover an old dead lock and refuses a live one',()=>{
 const root=prepare(),key='123456789012';
 stale(root,key);
 const unlock=acquireProductLock(root,key,{recoveryOptions:dead});
 try{assert.ok(['active','unknown'].includes(inspectLock(root,key).status))}
 finally{unlock()}
 const vault=join(root,'data','backups','stale-locks');
 assert.equal(readdirSync(vault).length,1);
});
test('registry write lock can be recovered without blocking other product operations',async()=>{
 const root=prepare();
 stale(root,'registry');
 let entered=0;
 const result=await withShortLock(root,()=>{entered++;return 'ok'},{
  timeoutMs:900,recoveryOptions:dead
 });
 assert.equal(result,'ok');assert.equal(entered,1);
 assert.equal(inspectLock(root,'registry').status,'absent');
 assert.equal(readdirSync(join(root,'data','backups','stale-locks')).length,1);
});
test('OS PID liveness check recognizes a real exited child process',()=>{
 const child=spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],
  {encoding:'utf8',windowsHide:true,timeout:10000});
 assert.equal(child.status,0);
 const pid=Number(child.stdout.trim());
 assert.ok(Number.isSafeInteger(pid)&&pid!==process.pid);
 const root=prepare(),key='123456789012',folder=lockPath(root,key);
 mkdirSync(folder,{recursive:true});
 writeFileSync(join(folder,'owner.json'),JSON.stringify({
  pid,token:randomUUID(),startedAt:new Date(Date.now()-60000).toISOString()
 }));
 const result=inspectLock(root,key,{minAgeMs:0});
 assert.ok(['stale','unknown'].includes(result.status),result.status);
 if(result.status==='stale'){
  const archived=archiveStaleLock(root,key,{minAgeMs:0});
  assert.equal(archived.status,'archived');
  assert.ok(existsSync(archived.backup));
 }else{
  // Windows may change an exited child's PID state from unknown to dead between probes.
  // Hold liveness unknown here to verify the refusal path deterministically.
  assert.throws(()=>archiveStaleLock(root,key,{minAgeMs:0,checkPid:()=> 'unknown'}),/Refusing to archive/);
  assert.ok(existsSync(folder));
 }
});
test('liveness uncertainty leaves existing lock unchanged',()=>{
 const root=prepare(),key='123456789012',path=stale(root,key);
 assert.equal(inspectLock(root,key,{minAgeMs:0,checkPid:()=> 'unknown'}).status,'unknown');
 assert.throws(()=>archiveStaleLock(root,key,{minAgeMs:0,checkPid:()=> 'unknown'}));
 assert.ok(existsSync(path));
});
