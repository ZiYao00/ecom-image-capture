#!/usr/bin/env node
// Recover halted V2 and partial V3 jobs without replaying any previously submitted slot.
import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {acquireProductLock,canonicalProductUrl,readRegistry} from './capture-store.mjs';
import {assertIndustryMigrationNotActive} from './eagle-industry-move.mjs';
import {loadJob} from './v3-job-state.mjs';
import {holdWorkflowLock} from './workflow-lock.mjs';
import {buildLegacyRecoveryPlan,receiptDigest,inspectPartialJournal} from './v3-recovery-core.mjs';
import {verifyDeliveryMode} from './copy-delivery.mjs';
import {visibleEagleItemCount,assertFingerprintInventory,syncV3StitchPartsToIndex,refreshFingerprintIndex,listWebApiItems} from './v3-fingerprint.mjs';
import {processV3ImportedImages,eagleV2GetById} from './v3-eagle-import.mjs';
import {eagleArchiveRpc,ensureEagleProductFolders,archiveEagleProduct,ECOM_ARCHIVE_ROOT} from './eagle-archive.mjs';
import {createV3ReadbackRpc} from './v3-web-readback.mjs';
import {makeMap,saveMap,loadMap} from './eagle-product-map.mjs';
import {mirrorEagleMap} from './eagle-map-mirror.mjs';
import {readCurrentEagleProduct} from './eagle-current.mjs';
import {stitchEagleProduct} from './stitch-eagle-core.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const argv=process.argv.slice(2),recoveryOnly=argv[0]==='--recovery-only';
if(recoveryOnly)argv.shift();
const [mode,id,sourceUrl]=argv;
if(!['--check','--apply'].includes(mode)||!/^[0-9]{8,16}$/.test(id||'')||argv.length>3)
  throw Error('Usage: v3-resume-partial.mjs --check|--apply <productId> [originalTmallUrl]');
const cfg=JSON.parse(readFileSync(join(root,'config','local.json'),'utf8'));
if(cfg.v3Experimental!==true&&!recoveryOnly)throw Error('V3 experimental mode disabled');
if(Number(process.versions.node.split('.')[0])<24)throw Error('Partial recovery requires Node >=24');
const workflow=holdWorkflowLock(root);
if(recoveryOnly&&!workflow.delegated)throw Error('Recovery-only must run under the explicit recovery coordinator');
const file=join(root,'data','runs','stable-'+id,'receipt.json');
if(!existsSync(file))throw Error('No original stable receipt');
assertIndustryMigrationNotActive(root);
const release=mode==='--apply'?acquireProductLock(root,id):null;
try{
  const original=readFileSync(file),receipt=JSON.parse(original.toString('utf8'));
  const digest=receiptDigest(original);
  const job=loadJob(root,id);
  if(receipt.productId!==id||!Array.isArray(receipt.images)||!receipt.images.length)
    throw Error('Receipt identity/source mismatch');
  const registry=readRegistry(root).products[id];
  if(registry?.workflowStatus==='complete')throw Error('Product is already complete; use verify-live, not recovery');
  const legacy=receipt.captureVersion!=='v3.1-experimental';
  if(!legacy&&!job)throw Error('V3 durable job missing');
  const legacyPlan=legacy?buildLegacyRecoveryPlan(receipt,original):null;
  if(legacy&&!sourceUrl&&!job)throw Error('Legacy recovery needs the original user-provided product URL');
  const identity=canonicalProductUrl(sourceUrl||job?.url||'');
  if(identity.productId!==id||String(identity.skuId||'')!==String(receipt.skuId||'')||
      (job&&job.url!==identity.url))throw Error('Product or original SKU/URL does not match recovery receipt');
  const rpc=(name,args)=>eagleArchiveRpc(cfg.eagleMcpUrl,name,args);
  const app=await rpc('get_app_info',{});
  if(!app?.libraryPath)throw Error('Active Eagle library path missing');
  const folders=await ensureEagleProductFolders({rpc,productId:id,
    rootName:cfg.eagleArchiveRootName||ECOM_ARCHIVE_ROOT,apply:false});
  if(!folders||folders.product!==receipt.folderIds?.product||
     folders.main!==receipt.folderIds?.main||folders.detail!==receipt.folderIds?.detail)
    throw Error('Recorded Eagle product folder identity changed');
  const oldMap=loadMap(root,id,receipt.images);
  if(oldMap&&oldMap.libraryPath&&oldMap.libraryPath.toLowerCase()!==app.libraryPath.toLowerCase())
    throw Error('Existing map belongs to another Eagle library');
  const args={root,productId:id,url:identity.url,images:receipt.images,
    libraryPath:app.libraryPath,folderIds:folders,
    indexPath:join(root,'data','fingerprints','v3-eagle.sqlite'),
    resumePartial:!!job,legacyPlan,
    checkLibrary:async()=>{
      const current=await rpc('get_app_info',{});
      if(!current?.libraryPath||resolve(current.libraryPath).toLowerCase()!==resolve(app.libraryPath).toLowerCase())throw Error('Active Eagle library identity changed');
      return visibleEagleItemCount();
    },
    checkInventory:assertFingerprintInventory,
    refreshInventory:(index,path)=>refreshFingerprintIndex(index,path,{listItems:async()=>{
      const current=await rpc('get_app_info',{});
      if(!current?.libraryPath||resolve(current.libraryPath).toLowerCase()!==resolve(path).toLowerCase())throw Error('Active Eagle library identity changed');
      return listWebApiItems();
    }}),
    linkFolders:(ids,fids)=>rpc('item_add_to_folders',{ids,folders:fids})};
  // All verified positions can be reconstructed from the durable job and
  // physically read back. No CDN prefetch or import stage is needed.
  const readRpc=createV3ReadbackRpc({eagleMcpUrl:cfg.eagleMcpUrl,libraryPath:app.libraryPath});
  let postprocess=null,checked;
  if(job?.slots?.length===receipt.images.length&&job.slots.every(s=>s.state==='verified')){
    inspectPartialJournal(root,job,receipt.images,app.libraryPath,identity.url,legacyPlan);
    const map=makeMap(id,job.slots.map(s=>({...s,verified:true})),{
      libraryPath:app.libraryPath,folders:{main:folders.main,detail:folders.detail}});
    const live=await readCurrentEagleProduct({rpc:readRpc,productId:id,images:receipt.images,productMap:map});
    if(live.status!=='complete'||live.invalid.length||live.missing.length)
      throw Error('Verified job originals no longer agree with live Eagle; no reimport');
    postprocess={map,live};
    checked={status:'ready_partial_recovery',protected:live.items.length,pending:0,
      evidence:live.items.map(s=>({name:s.name,itemId:s.id,sha256:s.sha256,kind:'verified'}))};
  }else checked=await processV3ImportedImages({...args,checkOnly:true});
  // Existing product mappings must agree with all previously verified source positions.
  for(const s of oldMap?.slots||[]){
    if(!s.itemId)continue;
    const e=checked.evidence.find(x=>x.name===s.name);
    if(!e||e.itemId!==s.itemId||e.sha256!==s.sha256)throw Error('Existing map conflicts with read-only recovery: '+s.name);
  }
  const preflight={productId:id,sourceCount:receipt.images.length,main:receipt.selected?.main,
    detail:receipt.selected?.detail,protected:checked.protected,pending:checked.pending,
    receiptSha256:digest,originalReceiptModified:false,resumeStage:postprocess?'postprocess_only':'slot_recovery'};
  if(mode==='--check'){
    console.log(JSON.stringify({status:checked.status,...preflight,evidence:checked.evidence,eagleWrites:0},null,2));
  }else{
    let map,current,archive;
    if(postprocess){
      ({map,live:current}=postprocess);archive={status:'complete'};
    }else{
      const imported=await processV3ImportedImages(args);
      if(imported.status!=='verified'||imported.images.length!==receipt.images.length)
        throw Error('Recovered import is not complete');
      archive=await archiveEagleProduct({rpc:readRpc,productId:id,images:imported.images,
        rootName:cfg.eagleArchiveRootName||ECOM_ARCHIVE_ROOT,apply:false});
      if(archive.status!=='complete')throw Error('Archive not physically complete: '+archive.status);
      map=makeMap(id,imported.images,{libraryPath:app.libraryPath,
        folders:{main:folders.main,detail:folders.detail}});
      current=await readCurrentEagleProduct({rpc:readRpc,productId:id,images:receipt.images,productMap:map});
    }
    if(current.status!=='complete'||current.invalid.length||current.missing.length)
      throw Error('Proposed recovered map not independently complete');
    saveMap(root,map);
    const mirrored=await mirrorEagleMap({rpc:readRpc,map,apply:true});
    if(mirrored.status!=='complete')throw Error('Cannot verify Eagle mapping mirror');
    const delivery=await verifyDeliveryMode(current,receipt,registry,{apply:true});
    if(delivery.status!=='complete')throw Error('Recorded storage-mode delivery incomplete');
    if(!process.env.STITCH_FFMPEG&&cfg.ffmpegExecutablePath)process.env.STITCH_FFMPEG=cfg.ffmpegExecutablePath;
    if(!process.env.STITCH_FFPROBE&&cfg.ffprobeExecutablePath)process.env.STITCH_FFPROBE=cfg.ffprobeExecutablePath;
    const stitch=await stitchEagleProduct({rpc:readRpc,productId:id,images:receipt.images,
      rootName:cfg.eagleArchiveRootName||ECOM_ARCHIVE_ROOT,width:750,apply:true,outputRoot:join(root,'data','stitch-eagle')});
    if(!['complete','already_complete'].includes(stitch.status))
      throw Error('Recovered originals complete but long image needs review: '+stitch.status);
    let indexSync={status:'not_required'};
    if(stitch.status==='complete')indexSync=await syncV3StitchPartsToIndex({indexPath:args.indexPath,
      libraryPath:app.libraryPath,parts:stitch.parts,getById:eagleV2GetById,getLiveCount:visibleEagleItemCount});
    if(receiptDigest(readFileSync(file))!==digest)throw Error('Original receipt changed during recovery');
    const report={status:'complete',...preflight,verified:current.items.length,archive:archive.status,delivery,
      map:map.status,mirror:mirrored.status,longStatus:stitch.status,indexSync,
      registryNeedsVerifyLiveApply:true,at:new Date().toISOString()};
    const dir=join(root,'data','reconciliations');mkdirSync(dir,{recursive:true});
    const reportFile=join(dir,'v3-partial-recovered-'+id+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,6)+'.json');
    writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({...report,reportPath:reportFile},null,2));
  }
}catch(error){
  console.error(JSON.stringify({status:'needs_read_only_review',productId:id,error:String(error.message||error),noAutomaticImportRetry:true},null,2));
  process.exitCode=2;
}finally{release?.()}
