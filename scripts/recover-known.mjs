#!/usr/bin/env node
// Read-only by default. Optional --apply recovers only items that EXIST in Eagle.
// Never invokes item_add, retries unknown submissions or modifies successful receipts.
import {readFileSync,existsSync,mkdirSync,writeFileSync,renameSync,copyFileSync,
  statSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {uniqueExactMatches,applyRecovered,repairCopyState} from './recovery-core.mjs';
import {acquireProductLock,updateProduct,captureSummary,readRegistry} from './capture-store.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),apply=args[0]==='--apply';
const id=apply?args[1]:args[0],destRoot=apply?args[2]:null;
if(!/^\d{8,16}$/.test(id||'')||(apply&&!destRoot)||args.length!==(apply?3:1))
 throw Error('Usage: node scripts/recover-known.mjs <product ID> [read-only] OR --apply <product ID> "<output root>"');
if(apply)acquireProductLock(root,id);
const file=join(root,'data','runs','stable-'+id,'receipt.json');
if(!existsSync(file))throw Error('No receipt for product '+id);
const sourceBytes=readFileSync(file);
const receipt=JSON.parse(sourceBytes.toString('utf8'));
if(receipt.productId!==id)throw Error('Receipt ID mismatch');
if(receipt.phase==='success') {
 console.log(JSON.stringify({status:'already_successful',id,changed:false}));process.exit(0);
}
const unknown=receipt.images.filter(x=>x.verified!==true);
if(!unknown.length&&!apply){
 console.log(JSON.stringify({status:'no_missing_eagle_items',id,changed:false}));process.exit(0);
}
const readCfg=name=>{const p=join(root,'config',name);return existsSync(p)?JSON.parse(readFileSync(p,'utf8')):{}};
const cfg={...readCfg('local.example.json'),...readCfg('local.json')};
const endpoint=process.env.EAGLE_MCP_URL||cfg.eagleMcpUrl;
async function keywordSearch(name){
 const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream'},
 body:JSON.stringify({jsonrpc:'2.0',id:1102,method:'tools/call',params:{name:'item_get',
  arguments:{keywords:[name],limit:100,offset:0,fullDetails:true}}}),signal:AbortSignal.timeout(25000)});
 if(!r.ok)throw Error('Eagle HTTP '+r.status);
 const raw=await r.text(),line=raw.split(/\r?\n/).find(x=>x.startsWith('data:'));
 const message=JSON.parse(line?line.slice(5):raw);
 if(message.error||message.result?.isError)throw Error('Eagle item_get failed');
 const payload=JSON.parse(message.result.content.find(x=>x.type==='text').text);
 if(payload.success===false)throw Error('Eagle search reported failure');
 const data=payload.data??payload,items=Array.isArray(data)?data:(data.items||[]);
 if(!Array.isArray(items)||items.length>=100)throw Error('Search incomplete/ambiguous; refuse modification');
 return items;
}
const found=[];
for(const record of unknown)found.push(...await keywordSearch(record.name));
const {matches,issues}=uniqueExactMatches(unknown,found);
const candidate=applyRecovered(receipt,matches);
if(!apply){
 console.log(JSON.stringify({status:issues.length?'needs_manual_review':'known_items_recoverable',
  id,unknown:unknown.length,matched:matches.size,issues,allVerified:candidate.eagle==='verified',
  changed:false,mode:'read_only'},null,2));
 if(issues.length)process.exitCode=2;
 process.exit(issues.length?2:0);
}
if(issues.length||candidate.eagle!=='verified'){
 console.log(JSON.stringify({status:'blocked',id,reason:'Some items not uniquely found in Eagle; item_add is never retried',
 issues,changed:false},null,2));process.exit(2);
}
const output=resolve(destRoot,id);
const fromIndex=readRegistry(root).products[id];
if(fromIndex?.outputDir&&resolve(fromIndex.outputDir)!==output)
 throw Error('Output root mismatch with captures.json; refusing relocation');
const existingDest=receipt.destination;
if(existingDest&&resolve(existingDest)!==output)
 throw Error('Output root mismatch with recorded receipt; refusing to relocate');
const backup=join(root,'data','backups','recovery-'+id+'-'+Date.now()+'.json');
// The shared per-product lock, already acquired above, prevents concurrent recovery.
let copied=0;
try{
 if(!readFileSync(file).equals(sourceBytes))throw Error('Receipt modified by another Agent; cancel recovery');
 const toCopy=[];
 for(const item of candidate.images){
  if(!item.verified||!item.filePath||!existsSync(item.filePath))throw Error('Missing Eagle file '+item.name);
  const ext=String(item.ext||'jpg').toLowerCase().replace(/[^a-z0-9]/g,'')||'jpg';
  const dest=join(output,item.category,String(item.order).padStart(2,'0')+'.'+ext);
  if(existsSync(dest)){
   if(statSync(dest).size!==statSync(item.filePath).size)throw Error('Destination conflict: '+dest);
   const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
   if(hash(dest)!==hash(item.filePath))throw Error('Destination content conflict: '+dest);
  }else toCopy.push({src:item.filePath,dest});
 }
 mkdirSync(dirname(backup),{recursive:true});
 writeFileSync(backup,sourceBytes,{flag:'wx'});
 for(const {src,dest} of toCopy){
  mkdirSync(dirname(dest),{recursive:true});
  if(!existsSync(dest)){copyFileSync(src,dest);copied++;}
 }
 // Same output constraints as standard capture; retain audit of previous errors instead of deleting evidence.
 candidate.previousRecoveryErrors=[...(receipt.previousRecoveryErrors||[]),...(receipt.errors||[])];
 candidate.errors=[];
 candidate.destination=output;
 const validation=repairCopyState(candidate,{copied:candidate.images.length,errors:[],destination:output});
 Object.assign(candidate,validation);
 if(candidate.phase!=='success')throw Error('Recovery did not reach verified state');
 const temp=file+'.recovery-tmp';
 writeFileSync(temp,JSON.stringify(candidate,null,2)+'\n');
 renameSync(temp,file);
 await updateProduct(root,captureSummary(candidate,{url:fromIndex?.url,outputDir:output}));
 console.log(JSON.stringify({status:'recovered',id,verified:candidate.images.length,newFiles:copied,
  destination:output,backup,neverReimported:true},null,2));
}finally{/* Product lock is released by the process-exit handler; no second lock directory. */}
