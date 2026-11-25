// Project-wide coordination for capture, index refresh, and recovery. A coordinator
// delegates one serial child at a time using its durable lease; stale/unknown
// owners are never silently removed. This cannot lock unrelated Eagle GUI actions.
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {inspectLock,lockPath} from './lock-health.mjs';

export function acquireWorkflowLock(root,{coordinator=false,env=process.env}={}){
  const key='workflow',childKey='workflow-child',leaseKey='ECOM_WORKFLOW_LEASE';
  const parent=inspectLock(root,key),inherited=env[leaseKey]||null;
  const delegated=!!inherited;
  if(delegated&&(parent.status!=='active'||parent.token!==inherited))
    throw Error('Workflow lease is stale or invalid; inspect locks before continuing');
  if(!delegated&&parent.status!=='absent')
    throw Error('Project workflow is '+parent.status+'; inspect workflow/child locks before continuing');
  const ownKey=delegated?childKey:key,dir=lockPath(root,ownKey);
  const childPath=lockPath(root,childKey);
  const parentPath=lockPath(root,key),reviewPath=join(parentPath,'review.json');
  if(existsSync(childPath)||delegated&&existsSync(reviewPath))
    throw Error('Workflow child or uncertain-operation evidence exists; inspect before continuing');
  // A nested coordinator borrows the existing parent lease without owning the
  // worker lock. Its children still have to acquire that single worker lock.
  const markUncertain=reason=>{
    const current=inspectLock(root,key);
    if(current.token!==(delegated?inherited:token))throw Error('Workflow owner missing or changed');
    try{writeFileSync(reviewPath,JSON.stringify({at:new Date().toISOString(),pid:process.pid,reason:String(reason).slice(0,500)})+'\n',{flag:'wx'})}
    catch(e){if(e.code!=='EEXIST')throw e;}
  };
  if(delegated&&coordinator)return {delegated:true,release:()=>{},markUncertain};
  mkdirSync(dirname(dir),{recursive:true});
  try{mkdirSync(dir)}catch(e){
    if(e.code==='EEXIST')throw Error('Workflow lock is already owned; no parallel writes');
    throw e;
  }
  const token=randomUUID(),owner={pid:process.pid,token,startedAt:new Date().toISOString(),
    ...(delegated?{parentToken:inherited}:{coordinator})};
  // If this write fails, retain the ambiguous directory for inspection.
  writeFileSync(join(dir,'owner.json'),JSON.stringify(owner)+'\n',{flag:'wx'});
  if(delegated){
    const check=inspectLock(root,key);
    if(check.status!=='active'||check.token!==inherited)
      throw Error('Workflow owner changed during delegation; preserve worker lock for review');
  }else if(coordinator)env[leaseKey]=token;
  let released=false;
  function release(){
    if(released)return;
    released=true;
    try{
      const live=JSON.parse(readFileSync(join(dir,'owner.json'),'utf8'));
      if(live.token!==token)throw Error('Workflow lock ownership changed');
      if(!delegated&&(existsSync(childPath)||existsSync(reviewPath))){
        // A timeout may leave a descendant alive; do not release the parent.
        return;
      }
      const history=join(root,'data','backups','workflow-locks');mkdirSync(history,{recursive:true});
      renameSync(dir,join(history,ownKey+'-'+token+'.lock'));
    }finally{
      if(!delegated&&coordinator&&env[leaseKey]===token)delete env[leaseKey];
    }
  }
  return {delegated,release,markUncertain};
}
// Register an exit release for existing CLI entrypoints with early process.exit.
// Explicit coordinator timeouts leave review evidence and therefore retain locks.
export function holdWorkflowLock(root,options){
  const lock=acquireWorkflowLock(root,options);
  process.once('exit',()=>{try{lock.release()}catch(error){console.error('Workflow release blocked: '+error.message);process.exitCode=2;}});
  return lock;
}
