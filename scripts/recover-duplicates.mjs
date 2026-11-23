#!/usr/bin/env node
// Optional recovery for <=10 missing images proven byte-identical to existing Eagle assets.
// Uses only locally authorized fallback files and Eagle's MCP APIs for writes.
// Every item_add is journaled and NEVER retried when uncertain; GIF animation must be preserved.
import {readFileSync,writeFileSync,existsSync,mkdirSync,statSync,readdirSync,createReadStream} from 'node:fs';
import {resolve,join,dirname,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readCurrentEagleProduct,hashEagleFile} from './eagle-current.mjs';
import {eagleArchiveRpc} from './eagle-archive.mjs';
import {acquireProductLock} from './capture-store.mjs';
import {addDistinctMetadata,metadataFormatFromPath} from './eagle-duplicate-core.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [id,mode]=process.argv.slice(2);
if(!/^\d{8,16}$/.test(id||'')||!['--check','--apply'].includes(mode)||process.argv.length!==4)
 throw Error('Usage: recover-duplicates.mjs <productId> --check|--apply');
const readJson=p=>JSON.parse(readFileSync(p,'utf8'));
const receipt=readJson(join(root,'data','runs','stable-'+id,'receipt.json'));
if(receipt.productId!==id||!Array.isArray(receipt.images)||!Array.isArray(receipt.eagleBatches))
 throw Error('Unsupported/legacy receipt (requires journaled V2 batches)');
const local=n=>{const p=join(root,'config',n);return existsSync(p)?readJson(p):{}};
const cfg={...local('local.example.json'),...local('local.json')};
const rpc=(name,args)=>eagleArchiveRpc(cfg.eagleMcpUrl,name,args,name==='item_add'?95000:45000);
const sha=async file=>{const h=createHash('sha256');for await (const bytes of createReadStream(file))h.update(bytes);return h.digest('hex')};
const run=(executable,args,timeout=90000)=>{
 const p=spawnSync(executable,args,{encoding:'utf8',windowsHide:true,timeout,maxBuffer:20*1024*1024});
 if(p.error||p.status!==0)throw Error(String(p.error?.message||p.stderr||p.stdout).slice(-1200));
 return p.stdout;
};
const frameRows=p=>run(cfg.ffmpegExecutablePath,['-v','error','-nostdin','-i',p,'-vf','format=rgba','-f','framemd5','-'])
 .split(/\r?\n/).filter(x=>x.trim()&&!x.startsWith('#')).map(x=>x.replace(/\s+/g,''));
const shape=p=>{
 const j=JSON.parse(run(cfg.ffprobeExecutablePath,['-v','error','-count_frames','-select_streams','v:0',
   '-show_entries','stream=width,height,nb_read_frames,duration','-of','json',p]));
 const s=j.streams?.[0];
 if(!s||!s.width||!s.height||!Number(s.nb_read_frames))throw Error('Could not inspect image '+p);
 return {width:s.width,height:s.height,frames:Number(s.nb_read_frames),duration:s.duration||null};
};
const scanDuplicates=async(library,files)=>{
 const imagesDir=resolve(library,'images');
 if(!existsSync(imagesDir))throw Error('Eagle library images directory unavailable');
 const sizes=new Map();
 for(const f of files){const a=sizes.get(f.size)||[];a.push(f);sizes.set(f.size,a)}
 const result=new Map(files.map(f=>[f.name,[]]));
 let dirs=0;
 for(const folder of readdirSync(imagesDir,{withFileTypes:true})){
  if(!folder.isDirectory()||!folder.name.endsWith('.info'))continue;
  dirs++;if(dirs>150000)throw Error('Too many Eagle items to scan safely');
  for(const f of readdirSync(join(imagesDir,folder.name),{withFileTypes:true})){
   if(!f.isFile()||!['.jpg','.jpeg','.png','.gif','.webp'].includes(extname(f.name).toLowerCase()))continue;
   const p=join(imagesDir,folder.name,f.name),st=statSync(p),targets=sizes.get(st.size);
   if(!targets)continue;
   const digest=await sha(p);
   for(const x of targets)if(x.sha256===digest)result.get(x.name).push(folder.name.slice(0,-5));
  }
 }
 return result;
};
const current=await readCurrentEagleProduct({rpc,productId:id,images:receipt.images,rootName:receipt.archive?.rootName||null});
if(current.status==='complete'&&!current.unrelated.length){
 console.log(JSON.stringify({status:'already_complete',id,counts:current.counts,changed:false},null,2));process.exit(0);
}
if(current.invalid.length||!current.folders?.detailFolderId)throw Error('Incomplete/invalid Eagle category folder');
const missing=current.missing;
if(!missing.length||missing.length>10||!['partially_verified','uncertain_no_retry'].includes(receipt.eagle))
 throw Error('Duplicate recovery requires 1..10 original partial Eagle items');
const available=new Map((receipt.directFallback||[]).map(x=>[x.name,x]));
const candidates=[];
for(const name of missing){
 const f=available.get(name),original=receipt.images.find(x=>x.name===name);
 if(!f||!original||f.order!==original.order||f.category!==original.category||
    !existsSync(f.file)||statSync(f.file).size!==f.size||await sha(f.file)!==f.sha256)
  throw Error('Missing/invalid local fallback '+name);
 candidates.push({...f});
}
const originalIds=(receipt.eagleBatches||[]).flatMap(x=>x.ids||[]);
const existing=await rpc('item_get',{ids:originalIds,fullDetails:true});
const saved=new Set((Array.isArray(existing)?existing:existing.items||[]).map(x=>x.id));
const ghosts=originalIds.filter(x=>!saved.has(x));
const app=await rpc('get_app_info',{});
if(!app?.libraryPath)throw Error('Eagle did not disclose current library path');
if(ghosts.length!==missing.length||ghosts.some(x=>existsSync(join(app.libraryPath,'images',x+'.info'))))
 throw Error('Uncertain prior item_add has not been safely resolved');
const doubles=await scanDuplicates(app.libraryPath,candidates);
for(const f of candidates){
 const ids=doubles.get(f.name);
 if(!ids?.length)throw Error('No exact duplicate to justify byte-distinct recovery: '+f.name);
 const matches=await rpc('item_get',{ids,fullDetails:true});
 const rows=Array.isArray(matches)?matches:matches.items||[];
 if(!rows.length)throw Error('Duplicate bytes exist on disk but no Eagle item to verify: '+f.name);
 if(!(await Promise.all(rows.map(async x=>{
  try{return (await hashEagleFile(x)).sha256===f.sha256}catch{return false}
 }))).some(Boolean))throw Error('Duplicate item physical verification failed: '+f.name);
 const exactName=await rpc('item_get',{keywords:[f.name],limit:100,offset:0,fullDetails:true});
 const existingNamed=Array.isArray(exactName)?exactName:exactName.items||[];
 if(existingNamed.some(x=>x.name===f.name))throw Error('Eagle already has exact-name item; classify instead: '+f.name);
}
const stateDir=join(root,'data','duplicate-recovery',id);
const journalFile=join(stateDir,'journal.json'),manifestFile=join(stateDir,'manifest.json');
if(existsSync(journalFile))throw Error('Previous duplicate-recovery submission exists; inspect, never retry');
if(mode==='--check'){
 console.log(JSON.stringify({status:'eligible',productId:id,missing,ghostIds:ghosts,
  duplicateMatches:Object.fromEntries([...doubles].map(([k,v])=>[k,v.length])),changed:false},null,2));
 process.exit(0);
}
const unlock=acquireProductLock(root,id);
let journal=null;
const save=()=>writeFileSync(journalFile,JSON.stringify(journal,null,2)+'\n','utf8');
try{
 mkdirSync(stateDir,{recursive:true});
 if(existsSync(manifestFile))throw Error('Existing duplicate recovery manifest; no automatic rebuild');
 const variantFiles=[];
 for(const f of candidates){
  const format=metadataFormatFromPath(f.file);
  const p=resolve(stateDir,f.name+'.'+(format||'png'));
  if(existsSync(p))throw Error('Variant file already exists');
  const pre=shape(f.file),sourceRows=frameRows(f.file);
  if(format){
   const identity=id+':'+f.name+':'+f.sha256.slice(0,12);
   writeFileSync(p,addDistinctMetadata(readFileSync(f.file),format,identity),{flag:'wx'});
  }else if(f.file.toLowerCase().endsWith('.webp')&&pre.frames===1){
   // Only static WebP; changing animated WebP to PNG would destroy motion.
   const intermediate=resolve(stateDir,f.name+'-intermediate.png');
   if(existsSync(intermediate))throw Error('Existing conversion file');
   run(cfg.ffmpegExecutablePath,['-v','error','-nostdin','-i',f.file,'-frames:v','1',
     '-pix_fmt','rgba','-compression_level','9',intermediate]);
   const identity=id+':'+f.name+':'+f.sha256.slice(0,12);
   writeFileSync(p,addDistinctMetadata(readFileSync(intermediate),'png',identity),{flag:'wx'});
  }else throw Error('Format not supported for lossless duplicate recovery '+f.name);
  if(JSON.stringify(shape(p))!==JSON.stringify(pre)||
     JSON.stringify(frameRows(p))!==JSON.stringify(sourceRows))
   throw Error('Recovered variant changed frame pixels or animation timing '+f.name);
  const digest=await sha(p);if(digest===f.sha256)throw Error('Variant has unchanged file hash '+f.name);
  variantFiles.push({name:f.name,source:f.file,variant:p,sourceSha256:f.sha256,sha256:digest,
    size:statSync(p).size,frames:pre.frames,width:pre.width,height:pre.height});
 }
 writeFileSync(manifestFile,JSON.stringify({status:'verified',productId:id,files:variantFiles,
   sourcesUnmodified:true,receiptUnmodified:true},null,2)+'\n',{flag:'wx'});
 journal={productId:id,status:'in_progress',items:{},startedAt:new Date().toISOString()};
 writeFileSync(journalFile,JSON.stringify(journal,null,2)+'\n',{flag:'wx'});
 for(const v of variantFiles){
  const now=await readCurrentEagleProduct({rpc,productId:id,images:receipt.images,rootName:receipt.archive?.rootName||null});
  if(!now.missing.includes(v.name))throw Error('Eagle target changed before submission '+v.name);
  journal.items[v.name]={status:'submitting',sha256:v.sha256,file:v.variant};save();
  const result=await rpc('item_add',{folders:[v.name.includes('-main-')?now.folders.mainFolderId:now.folders.detailFolderId],
   items:[{source:{type:'path',path:v.variant},name:v.name}]});
  const items=Array.isArray(result)?result:result.items||[];
  if(items.length!==1||items[0]?.success!==true)throw Error('Eagle did not acknowledge '+v.name);
  const itemId=items[0].itemId||items[0].id;if(!itemId)throw Error('Eagle returned no itemId for '+v.name);
  journal.items[v.name].itemId=itemId;journal.items[v.name].status='acknowledged';save();
  let verified=null;
  for(const ms of [350,900,1900,3400,5500]){
   await new Promise(ok=>setTimeout(ok,ms));
   const x=await rpc('item_get',{ids:[itemId],fullDetails:true});
   const item=(Array.isArray(x)?x:x.items||[]).find(y=>y.id===itemId&&y.name===v.name);
   if(!item)continue;
   try{
    const data=await hashEagleFile(item);
    if(data.sha256===v.sha256&&item.width===v.width&&item.height===v.height&&
        (item.folders||[]).includes(v.name.includes('-main-')?now.folders.mainFolderId:now.folders.detailFolderId)){
     verified={itemId,filePath:data.filePath,sha256:data.sha256,frames:v.frames};break;
    }
   }catch{}
  }
  if(!verified)throw Error('Eagle returned itemId without physical verified asset '+v.name);
  journal.items[v.name]={status:'verified',...verified};save();
 }
 const after=await readCurrentEagleProduct({rpc,productId:id,images:receipt.images,rootName:receipt.archive?.rootName||null});
 journal.status=after.status==='complete'&&!after.unrelated.length?'complete':'needs_read_only_review';
 journal.counts=after.counts;journal.missing=after.missing;journal.unrelated=after.unrelated;
 journal.finishedAt=new Date().toISOString();save();
 console.log(JSON.stringify({status:journal.status,id,counts:after.counts,missing:after.missing,
   unrelated:after.unrelated,verified:journal.items,originalsUnmodified:true},null,2));
 if(journal.status!=='complete')process.exitCode=2;
}catch(e){
 if(journal){journal.status='needs_read_only_review';journal.error=String(e.message||e);save();}
 console.error(JSON.stringify({status:'needs_read_only_review',error:String(e.message||e),
   noAutomaticRetry:true},null,2));process.exitCode=2;
}finally{unlock()}
