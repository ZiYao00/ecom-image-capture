// Guarded recovery for interrupted lock directories.
// A lock is never removed: a verified stale one is moved to data/backups/stale-locks.
// Ambiguous ownership and live processes are treated as active/unknown.
import {existsSync,readFileSync,statSync,mkdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export function lockPath(root,key){
 if(key==='registry')return join(root,'data','.captures-write-lock');
 if(!/^\d{8,16}$/.test(String(key)))throw Error('Lock key must be "registry" or an 8-16 digit product ID');
 return join(root,'data','locks','product-'+key+'.lock');
}
function processState(pid){
 if(pid===process.pid)return 'alive';
 try{process.kill(pid,0);return 'alive'}
 catch(e){return e?.code==='ESRCH'?'dead':'unknown'}
}
export function inspectLock(root,key,{now=Date.now(),minAgeMs=15000,checkPid=processState}={}){
 const dir=lockPath(root,key);
 if(!existsSync(dir))return {key,status:'absent'};
 let owner,ageMs;
 try{
  owner=JSON.parse(readFileSync(join(dir,'owner.json'),'utf8'));
  const date=Date.parse(owner.startedAt);
  const dirStat=statSync(dir);
  if(!Number.isSafeInteger(owner.pid)||owner.pid<1||typeof owner.token!=='string'||
     owner.token.length<10||!Number.isFinite(date)||date>now+2000)
   throw Error('Invalid owner PID, token or timestamp');
  ageMs=now-Math.max(date,dirStat.birthtimeMs||0);
  if(!Number.isFinite(ageMs)||ageMs<0)throw Error('Lock age is not verifiable');
 }catch(e){
  return {key,status:'unknown',reason:'Cannot verify lock owner metadata: '+e.message};
 }
 const liveness=owner.pid===process.pid?'alive':checkPid(owner.pid);
 const status=liveness==='alive'?'active':
   liveness==='dead'&&ageMs>=minAgeMs?'stale':'unknown';
 return {key,status,pid:owner.pid,token:owner.token,
  startedAt:owner.startedAt,ageMs:Math.floor(ageMs),
  ...(status==='unknown'?{reason:liveness==='dead'?'Dead PID, but lock is too new':'PID liveness is unknown'}:{})};
}
export function archiveStaleLock(root,key,options={}){
 const before=inspectLock(root,key,options);
 if(before.status!=='stale')throw Error('Refusing to archive '+key+' lock: '+before.status+
  (before.reason?' ('+before.reason+')':''));
 const after=inspectLock(root,key,options);
 if(after.status!=='stale'||before.pid!==after.pid||before.token!==after.token)
  throw Error('Lock owner changed during check; refuse recovery');
 const source=lockPath(root,key);
 const vault=join(root,'data','backups','stale-locks');
 mkdirSync(vault,{recursive:true});
 const dest=join(vault,String(key)+'-'+Date.now()+'-'+randomUUID()+'.lock');
 renameSync(source,dest);
 const archived=JSON.parse(readFileSync(join(dest,'owner.json'),'utf8'));
 if(archived.token!==before.token||archived.pid!==before.pid)
  throw Error('Lock owner changed during archival: '+dest+'; manual review required');
 return {key,status:'archived',pid:before.pid,backup:dest};
}
