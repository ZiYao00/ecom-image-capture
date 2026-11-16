#!/usr/bin/env node
// Read-only by default. Explicit --apply <product ID> repairs captures.json only.
import {readdirSync,existsSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readRegistry} from './capture-store.mjs';
import {reconcileProduct} from './receipt-sync.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args.length===1&&args[0]==='--help'){
 console.log('node scripts/reconcile-captures.mjs --check');
 console.log('node scripts/reconcile-captures.mjs --apply <product ID>');
 console.log('Apply only updates data/captures.json after SHA-256 verification; never accesses Eagle.');
 process.exit(0);
}
if(args.length===2&&args[0]==='--apply'){
 const result=await reconcileProduct(root,args[1],{apply:true});
 console.log(JSON.stringify(result,null,2));
 if(!['consistent','repaired'].includes(result.status))process.exitCode=2;
}else if(args.length===0||(args.length===1&&args[0]==='--check')){
 const ids=new Set(Object.keys(readRegistry(root).products));
 const dir=join(root,'data','runs');
 if(existsSync(dir))for(const x of readdirSync(dir,{withFileTypes:true})){
  const m=x.isDirectory()&&x.name.match(/^stable-(\d{8,16})$/);
  if(m)ids.add(m[1]);
 }
 const results=[],errors=[];
 for(const id of [...ids].sort()){
  try{results.push(await reconcileProduct(root,id))}
  catch(e){errors.push({id,error:e.message})}
 }
 const outOfSync=results.filter(x=>x.status==='out_of_sync');
 const conflicts=results.filter(x=>x.status==='conflict');
 console.log(JSON.stringify({status:errors.length||outOfSync.length||conflicts.length?'needs_reconciliation':'passed',
  checked:results.length,outOfSync:outOfSync.length,conflicts:conflicts.length,errors,results},null,2));
 if(errors.length||outOfSync.length||conflicts.length)process.exitCode=2;
}else throw Error('Usage: node scripts/reconcile-captures.mjs --check OR --apply <product ID>');
