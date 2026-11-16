#!/usr/bin/env node
// Explicit, capped last-resort download. Eagle remains the normal image downloader.
// Never calls item_add, never retries an uncertain Eagle submission.
import {readFileSync,writeFileSync,existsSync,statSync,mkdirSync,renameSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {enforceDirectFallback} from './capture-policy.mjs';
import {generateDetailPreview} from './html-preview.mjs';
import {readRegistry,updateProduct,captureSummary,acquireProductLock} from './capture-store.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const apply=args[0]==='--apply',id=apply?args[1]:args[0];
if(!/^\d{8,16}$/.test(id||'')||args.length!==(apply?2:1))
  throw Error('Usage: node scripts/recover-direct.mjs <productId> OR --apply <productId>');
const runDir=join(root,'data','runs','stable-'+id),receiptPath=join(runDir,'receipt.json');
if(!existsSync(receiptPath))throw Error('No existing capture receipt for '+id);
if(apply)acquireProductLock(root,id);
const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));
if(receipt.productId!==id)throw Error('Receipt productId mismatch');
const record=readRegistry(root).products[id];
const output=record?.outputDir||receipt.destination;
if(!output)throw Error('No recorded product output directory');
if(receipt.destination&&resolve(receipt.destination)!==resolve(output))throw Error('Receipt output path conflict');
const missing=receipt.images.filter(x=>x.verified!==true&&!receipt.directFallback?.some(a=>a.name===x.name));
const budget=enforceDirectFallback(receipt,missing.map(x=>x.name));
if(!missing.length){console.log(JSON.stringify({status:'nothing_to_download',budget,changed:false}));process.exit(0)}
const load=name=>{const p=join(root,'config',name);return existsSync(p)?JSON.parse(readFileSync(p,'utf8')):{}};
const cfg={...load('local.example.json'),...load('local.json')};
const eagleUrl=process.env.EAGLE_MCP_URL||cfg.eagleMcpUrl;
if(!eagleUrl)throw Error('Eagle MCP required for read-only checking');
async function searchEagle(name){
  const res=await fetch(eagleUrl,{
    method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0',id:1001,method:'tools/call',
      params:{name:'item_get',arguments:{keywords:[name],limit:100,offset:0,fullDetails:true}}}),
    signal:AbortSignal.timeout(30000)
  });
  if(!res.ok)throw Error('Eagle MCP unavailable: HTTP '+res.status);
  const raw=await res.text(),line=raw.split(/\r?\n/).find(s=>s.startsWith('data:'));
  const rpc=JSON.parse(line?line.slice(5).trim():raw);
  if(rpc.error||rpc.result?.isError)throw Error('Eagle item_get failed; direct fallback prohibited');
  const dataText=rpc.result?.content?.find(x=>x.type==='text')?.text;
  if(!dataText)throw Error('Eagle item_get response is empty');
  const payload=JSON.parse(dataText);
  if(payload.success===false)throw Error('Eagle item_get did not succeed');
  const data=payload.data??payload;
  const items=Array.isArray(data)?data:(data.items||[]);
  if(!Array.isArray(items)||items.length>=100)throw Error('Eagle search truncated/ambiguous');
  return items.filter(x=>x.name===name);
}
const conflicts=[];
for(const item of missing){
  const matches=await searchEagle(item.name);
  if(matches.length)conflicts.push(item.name+': '+matches.length+' exact item(s) already exist in Eagle');
}
if(conflicts.length){
  console.log(JSON.stringify({status:'eagle_recovery_required',conflicts,changed:false},null,2));
  process.exit(2);
}
if(!apply){
  console.log(JSON.stringify({status:'direct_fallback_eligible',id,missing:missing.map(x=>x.name),budget,
    eagleChecked:true,changed:false,next:'node scripts/recover-direct.mjs --apply '+id},null,2));
  process.exit(0);
}
// Second Eagle check before the network download, to avoid treating a delayed index as missing.
await new Promise(done=>setTimeout(done,1200));
for(const item of missing){
  if((await searchEagle(item.name)).length)throw Error('Eagle item appeared during delay; use recover-known instead: '+item.name);
}
const cdn=/^https:\/\/(?:[a-z0-9-]+\.)*(?:alicdn\.com|taobaocdn\.com|tbcdn\.cn)\//i;
const imageType=b=>{
  if(b.length>3&&b[0]===255&&b[1]===216&&b[2]===255)return 'jpg';
  if(b.length>8&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
  if(b.length>6&&['GIF87a','GIF89a'].includes(b.toString('ascii',0,6)))return 'gif';
  if(b.length>12&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP')return 'webp';
  throw Error('Non-image payload; refuse to save');
};
const backup=join(root,'data','backups','before-direct-'+id+'-'+Date.now()+'.json');
mkdirSync(dirname(backup),{recursive:true});
writeFileSync(backup,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
const save=()=>{
  const tmp=receiptPath+'.direct.tmp';
  writeFileSync(tmp,JSON.stringify(receipt,null,2)+'\n','utf8');
  renameSync(tmp,receiptPath);
};
for(const item of missing){
  if(!cdn.test(item.url))throw Error('Unsupported direct-download host for '+item.name);
  const url=new URL(item.url);
  if(url.protocol!=='https:')throw Error('HTTPS required');
  const destDir=join(output,item.category);
  const number=String(item.order).padStart(2,'0');
  // Any numbered file at this position is a conflict, even if its extension differs.
  const {readdirSync}=await import('node:fs');
  if(existsSync(destDir)&&readdirSync(destDir).some(n=>new RegExp('^'+number+'\\.(?:jpg|jpeg|png|gif|webp)$','i').test(n)))
    throw Error('Existing local image at '+item.category+'/'+number+'; refuse to overwrite');
  const res=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!res.ok)throw Error('Direct fallback HTTP '+res.status);
  if(Number(res.headers.get('content-length')||0)>30*1024*1024)throw Error('Image exceeds size limit');
  const bytes=Buffer.from(await res.arrayBuffer());
  if(!bytes.length||bytes.length>30*1024*1024)throw Error('Invalid image size');
  const ext=imageType(bytes);
  mkdirSync(destDir,{recursive:true});
  const destination=join(destDir,number+'.'+ext);
  writeFileSync(destination,bytes,{flag:'wx'});
  const sha256=createHash('sha256').update(bytes).digest('hex');
  receipt.directFallback=[...(receipt.directFallback||[]),{name:item.name,category:item.category,order:item.order,file:destination,size:bytes.length,sha256}];
  item.localSource='direct_fallback';
  item.localFilePath=destination;
  save();
}
const {readdirSync}=await import('node:fs');
const present=(receipt.images||[]).every(x=>{
  const base=join(output,x.category),name=String(x.order).padStart(2,'0');
  return existsSync(base)&&readdirSync(base).some(f=>new RegExp('^'+name+'\\.(?:jpg|jpeg|png|gif|webp)$','i').test(f)&&statSync(join(base,f)).size>0);
});
receipt.localStatus=present?'complete':'incomplete';
if(present){
  try{receipt.postprocess={...receipt.postprocess,html:generateDetailPreview(join(output,'detail'),{productId:id})};}
  catch(e){receipt.postprocess={...receipt.postprocess,html:{status:'failed',error:String(e.message||e)}};}
}
receipt.copied=receipt.images.filter(x=>{
  const base=join(output,x.category),name=String(x.order).padStart(2,'0');
  return existsSync(base)&&readdirSync(base).some(f=>new RegExp('^'+name+'\\.(?:jpg|jpeg|png|gif|webp)$','i').test(f)&&statSync(join(base,f)).size>0);
}).length;
save();
await updateProduct(root,captureSummary(receipt,{outputDir:output}));
console.log(JSON.stringify({status:'direct_fallback_recorded',id,downloaded:missing.length,
  totalFallback:receipt.directFallback.length,localStatus:receipt.localStatus,
  eagleStatus:receipt.eagle,backup,output},null,2));
