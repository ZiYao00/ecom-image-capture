#!/usr/bin/env node
// Run from project root. Read-only by default; explicit --archive-stale never deletes locks.
import {existsSync,readdirSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectLock,archiveStaleLock} from './lock-health.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args[0]==='--help'){
 console.log('node scripts/lock-health-cli.mjs status');
 console.log('node scripts/lock-health-cli.mjs --archive-stale <product ID|registry|workflow|workflow-child>');
 process.exit(0);
}
if(args[0]==='--archive-stale'&&args.length===2){
 const value=archiveStaleLock(root,args[1]);
 console.log(JSON.stringify({status:value.status,key:value.key,archivedTo:value.backup,originalDeleted:false},null,2));
}else if(args.length===0||(args.length===1&&args[0]==='status')){
 const folder=join(root,'data','locks');
 const keys=['registry','workflow','workflow-child'];
 if(existsSync(folder))for(const d of readdirSync(folder,{withFileTypes:true})){
  const match=d.isDirectory()&&d.name.match(/^product-(\d{8,16})\.lock$/);
  if(match)keys.push(match[1]);
 }
 const locks=keys.map(key=>{
  const {token,...status}=inspectLock(root,key);
   if(key==='workflow')status.uncertainEvidence=existsSync(join(root,'data','locks','workflow.lock','review.json'));
   return status;
 });
 console.log(JSON.stringify({status:locks.some(x=>x.status==='unknown')?'review_needed':'checked',locks},null,2));
}else throw Error('Usage: node scripts/lock-health-cli.mjs status OR --archive-stale <product ID|registry|workflow|workflow-child>');
