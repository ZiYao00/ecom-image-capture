#!/usr/bin/env node
// V3.1 recovery ONLY when all durable events prove no Eagle import or link was ever attempted.
// Leave original capture receipt immutable. Never use this CLI to retry an uncertain Eagle write.
import{readFileSync,existsSync,mkdirSync,writeFileSync}from'node:fs';
import{resolve,join,dirname}from'node:path';
import{fileURLToPath}from'node:url';
import{randomUUID}from'node:crypto';
import{acquireProductLock}from'./capture-store.mjs';
import{loadJob,assertNoWriteResume}from'./v3-job-state.mjs';
import{visibleEagleItemCount,openFingerprintDatabase,syncV3StitchPartsToIndex}from'./v3-fingerprint.mjs';
import{processV3ImportedImages,eagleV2GetById}from'./v3-eagle-import.mjs';
import{eagleArchiveRpc,ensureEagleProductFolders,archiveEagleProduct,ECOM_ARCHIVE_ROOT}from'./eagle-archive.mjs';
import{createV3ReadbackRpc}from'./v3-web-readback.mjs';
import{makeMap,saveMap}from'./eagle-product-map.mjs';
import{mirrorEagleMap}from'./eagle-map-mirror.mjs';
import{readCurrentEagleProduct}from'./eagle-current.mjs';
import{stitchEagleProduct}from'./stitch-eagle-core.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [mode,id]=process.argv.slice(2);
if(!['--check','--apply'].includes(mode)||!/^[0-9]{8,16}$/.test(id||'')||process.argv.length!==4)
 throw Error('Usage: node scripts/v3-resume-no-write.mjs --check|--apply <productId>');
const cfg=JSON.parse(readFileSync(join(root,'config','local.json'),'utf8'));
if(cfg.v3Experimental!==true)throw Error('V3 experimental mode disabled');
const receiptFile=join(root,'data','runs','stable-'+id,'receipt.json');
if(!existsSync(receiptFile))throw Error('No stable V3 original receipt');
const receipt=JSON.parse(readFileSync(receiptFile,'utf8'));
if(receipt.productId!==id||receipt.captureVersion!=='v3.1-experimental'||!Array.isArray(receipt.images)||
  !receipt.images.length||receipt.phase==='success')throw Error('Unexpected V3 recovery receipt');
const job=loadJob(root,id);
if(!job)throw Error('V3 durable job missing');
const rpc=(name,args)=>eagleArchiveRpc(cfg.eagleMcpUrl,name,args);
const app=await rpc('get_app_info',{});
const url=job.url;
const proof=assertNoWriteResume(root,job,receipt.images,app.libraryPath,url);
const indexPath=join(root,'data','fingerprints','v3-eagle.sqlite');
const index=await openFingerprintDatabase(indexPath,{libraryPath:app.libraryPath});
const indexedCount=Number(index.info().libraryItemTotal);index.close();
const visibleCount=await visibleEagleItemCount();
if(visibleCount!==indexedCount)throw Error('V3 index is stale; refresh read-only index before a zero-write recovery');
const folders=await ensureEagleProductFolders({rpc,productId:id,
 rootName:cfg.eagleArchiveRootName||ECOM_ARCHIVE_ROOT,apply:false});
if(!folders||folders.main!==receipt.folderIds?.main||folders.detail!==receipt.folderIds?.detail)
 throw Error('V3 current Eagle folders do not match recorded folder identities');
const preflight={productId:id,sourceCount:receipt.images.length,
  main:receipt.selected?.main,detail:receipt.selected?.detail,
  proof:proof.status,visibleEagleItems:visibleCount,receiptModified:false,
  cacheReady:job.slots.filter(s=>s.cachePath&&existsSync(s.cachePath)).length};
if(mode==='--check'){
 console.log(JSON.stringify({status:'ready_no_write_resumable',...preflight},null,2));process.exit(0);
}
const release=acquireProductLock(root,id);
try{
 const imported=await processV3ImportedImages({root,productId:id,url,images:receipt.images,
   libraryPath:app.libraryPath,folderIds:folders,indexPath,resumeNoWrite:true,
   linkFolders:(ids,fids)=>rpc('item_add_to_folders',{ids,folders:fids}),
   checkLibrary:visibleEagleItemCount});
 if(imported.status!=='verified'||imported.images.length!==receipt.images.length)
   throw Error('Incomplete V3 import result');
 const readRpc=createV3ReadbackRpc({eagleMcpUrl:cfg.eagleMcpUrl,libraryPath:app.libraryPath});
 const archive=await archiveEagleProduct({rpc:readRpc,productId:id,images:imported.images,
   rootName:cfg.eagleArchiveRootName||ECOM_ARCHIVE_ROOT,apply:false});
 if(archive.status!=='complete')throw Error('Archive not physically complete: '+archive.status);
 const map=makeMap(id,imported.images,{libraryPath:app.libraryPath,
   folders:{main:folders.main,detail:folders.detail}});
 const current=await readCurrentEagleProduct({rpc:readRpc,productId:id,
   images:receipt.images,productMap:map});
 if(current.status!=='complete'||current.invalid.length||current.missing.length)
   throw Error('Proposed recovered map not independently complete');
 const saved=saveMap(root,map);
 const mirrored=await mirrorEagleMap({rpc:readRpc,map,apply:true});
 if(mirrored.status!=='complete')throw Error('Cannot verify Eagle mapping mirror');
 if(!process.env.STITCH_FFMPEG&&cfg.ffmpegExecutablePath)
   process.env.STITCH_FFMPEG=cfg.ffmpegExecutablePath;
 if(!process.env.STITCH_FFPROBE&&cfg.ffprobeExecutablePath)
   process.env.STITCH_FFPROBE=cfg.ffprobeExecutablePath;
 const stitch=await stitchEagleProduct({rpc:readRpc,productId:id,images:receipt.images,
   rootName:cfg.eagleArchiveRootName||ECOM_ARCHIVE_ROOT,width:750,apply:true,
   outputRoot:join(root,'data','stitch-eagle')});
 let indexSync={status:'not_required'};
 if(stitch.status==='complete')
   indexSync=await syncV3StitchPartsToIndex({indexPath,libraryPath:app.libraryPath,
     parts:stitch.parts,getById:eagleV2GetById,getLiveCount:visibleEagleItemCount});
 if(!['complete','already_complete'].includes(stitch.status))
   throw Error('Recovered source images complete but long image still needs review: '+stitch.status);
 const report={status:'complete',productId:id,main:preflight.main,detail:preflight.detail,
   verified:imported.images.length,archive:archive.status,map:map.status,mirror:mirrored.status,
   longStatus:stitch.status,indexSync,originalReceiptModified:false,
   registryNeedsVerifyLiveApply:true,at:new Date().toISOString()};
 const dir=join(root,'data','reconciliations');mkdirSync(dir,{recursive:true});
 const file=join(dir,'v3-recovered-'+id+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,6)+'.json');
 writeFileSync(file,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({...report,reportPath:file},null,2));
}catch(error){
 console.error(JSON.stringify({status:'needs_read_only_review',productId:id,
   error:String(error.message||error),originalReceiptModified:false,
   noAutomaticImportRetry:true},null,2));process.exitCode=2;
}finally{release()}
