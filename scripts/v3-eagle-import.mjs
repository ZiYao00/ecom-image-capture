// V3.1 deterministic single-image import orchestration.
// PREVENTS duplicate item_add: write an intent before any official API mutation.
import {existsSync,statSync} from 'node:fs';
import {requestEagle,eagleFailureDetails} from './eagle-request.mjs';
import {openFingerprintDatabase,inspectIndexedItem,chooseExactMatch,sha256File} from './v3-fingerprint.mjs';
import {prefetchOriginalRepresentation,validateOriginalRepresentation,saveCacheFile} from './v3-prefetch.mjs';
import {createJob,createStoredJob,recordJobEvent,acquireLibraryLock,maySubmitSlot,loadJob,assertNoWriteResume} from './v3-job-state.mjs';
import {inspectPartialJournal,protectedSlots,proveProtectedSlot} from './v3-recovery-core.mjs';

const pause=ms=>new Promise(done=>setTimeout(done,ms));
const isId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{8,64}$/.test(id);

export async function eagleV2GetById(id,{baseUrl='http://127.0.0.1:41595',fetchFn=fetch}={}) {
  if(!isId(id))throw Error('Unsafe Eagle ID');
  const uri=new URL('/api/v2/item/get',baseUrl);
  uri.searchParams.set('id',id);
  const data=await requestEagle({endpoint:uri,operation:'item_get',timeoutMs:30000,fetchFn});
  if(data.status!=='success'||!Array.isArray(data.data?.data))
    throw Error('Eagle V2 get invalid response');
  const rows=data.data.data.filter(x=>x.id===id);
  if(rows.length>1)throw Error('Eagle duplicate ID in get result');
  return rows[0]||null;
}

export async function eagleV2AddFromPath(image,{baseUrl='http://127.0.0.1:41595',fetchFn=fetch}={}) {
  if(!image?.path||!image?.name||!isId(image.folder))throw Error('Unsafe V3 Eagle path import');
  if(!existsSync(image.path)||statSync(image.path).size<12)throw Error('V3 original cache unavailable');
  const data=await requestEagle({endpoint:new URL('/api/v2/item/add',baseUrl),operation:'item_add',
    timeoutMs:90000,fetchFn,options:{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({path:image.path,name:image.name,folders:[image.folder],website:image.website})}});
  if(data.status!=='success')throw Error('Eagle V2 add rejected request: '+String(data.message||'unknown'));
  const payload=data.data;
  const id=typeof payload==='string'?payload:(payload?.id||payload?.itemId||payload?.item?.id);
  if(!isId(id))throw Error('Eagle acknowledged import without valid item ID; never automatically resubmit');
  return id;
}

export async function validateEagleCandidate(candidate,{getById,libraryPath,expectedSha,folderId}) {
  if(!candidate?.id||candidate.sha256!==expectedSha)return null;
  const item=await getById(candidate.id);
  if(!item||item.isDeleted===true)return null;
  const physical=await inspectIndexedItem(libraryPath,item);
  if(!physical||physical.sha256!==expectedSha)return null;
  return {...physical,verified:true,folders:item.folders||[],targetFolderId:folderId};
}

export async function verifyEagleById(id,{getById,libraryPath,expectedSha,folderId,delays=[0,400,1000,2300]}) {
  for(const delay of delays){
    if(delay)await pause(delay);
    const item=await getById(id);
    if(!item||item.isDeleted===true||!item.folders?.includes(folderId))continue;
    const physical=await inspectIndexedItem(libraryPath,item);
    if(physical?.sha256===expectedSha)return {...physical,verified:true};
  }
  return null;
}

export async function resolveV3ExactMatch({index,sha256,folderId,getById,libraryPath}) {
  const rows=index.lookup(sha256),checked=[];
  for(const candidate of rows){
    const proof=await validateEagleCandidate(candidate,{getById,libraryPath,expectedSha:sha256,folderId});
    if(proof)checked.push(proof);
  }
  if(rows.length&&checked.length===0)
    throw Error('Existing Eagle hash candidate is not verifiable; refresh read-only evidence, never reimport same bytes');
  return chooseExactMatch(checked,folderId);
}

export async function processV3ImportedImages({root,productId,url,images,libraryPath,folderIds,
  indexPath,getById=eagleV2GetById,importLocal=eagleV2AddFromPath,
  linkFolders,fetchImage=prefetchOriginalRepresentation,checkLibrary=null,checkInventory=null,refreshInventory=null,
  resumeNoWrite=false,resumePartial=false,legacyPlan=null,checkOnly=false}={}){
  if(!root||!libraryPath||!url||!Array.isArray(images)||!images.length||
     !folderIds?.main||!folderIds?.detail||typeof linkFolders!=='function')
    throw Error('Incomplete V3 import dependencies');
  const index=await openFingerprintDatabase(indexPath,{libraryPath});
  const out=[];
  let job=null;
  try {
    const indexInfo=index.info();
    if(!indexInfo.activeGeneration)throw Error('V3 fingerprint index has no verified generation');
    let expectedLibraryTotal=Number(indexInfo.libraryItemTotal),activeGeneration=indexInfo.activeGeneration,refreshes=0;
    if(!Number.isInteger(expectedLibraryTotal)||expectedLibraryTotal<0||typeof checkLibrary!=='function')
      throw Error('V3 needs a current full-library index and read-only count verifier');
    const recoveryMode=!!legacyPlan||resumePartial;
    if((resumeNoWrite&&recoveryMode)||(checkOnly&&!recoveryMode))
      throw Error('Incompatible V3 recovery modes');
    let journalProofs=null;
    if(resumeNoWrite){
      job=loadJob(root,productId);
      assertNoWriteResume(root,job,images,libraryPath,url);
    }else if(resumePartial){
      job=loadJob(root,productId);
      journalProofs=inspectPartialJournal(root,job,images,libraryPath,url,legacyPlan);
    }else{
      job=createJob({productId,url,slots:images,libraryPath});
      if(legacyPlan)job.recovery=legacyPlan;
      if(!checkOnly)createStoredJob(root,job); // Refuse existing jobs instead of overwriting history.
    }
    const protectedMap=recoveryMode?protectedSlots(images,legacyPlan,journalProofs):new Map();
    const verifiedProtected=new Map();
    async function prove(slot,proof){
      return proveProtectedSlot({slot,proof,index,folderId:folderIds[slot.category],
        getById,libraryPath,verifyById:verifyEagleById,validateCandidate:validateEagleCandidate});
    }
    async function guardInventory({allowRefresh=false}={}){
      const check=async()=>{
        if(index.info().activeGeneration!==activeGeneration)throw Error('Eagle fingerprint generation changed during operation');
        if(await checkLibrary()!==expectedLibraryTotal)
          throw Error('Eagle library changed since fingerprint indexing; safely stop before any new item_add');
        if(checkInventory)await checkInventory(index,libraryPath);
      };
      try{await check();}
      catch(error){
        const drift=/library changed since fingerprint indexing|inventory differs|inventory identity or physical metadata changed/.test(String(error.message||error));
        if(!allowRefresh||!drift||refreshes||typeof refreshInventory!=='function')throw error;
        // One incremental refresh, only before the first new import/link phase.
        // Prior protected positions are subsequently re-proved by exact bytes.
        refreshes++;
        const refreshed=await refreshInventory(index,libraryPath);
        if(refreshed?.status!=='index_ready')throw Error('Incremental inventory refresh did not complete');
        const info=index.info();activeGeneration=info.activeGeneration;expectedLibraryTotal=Number(info.libraryItemTotal);
        await check();
        recordJobEvent(root,job,{event:'prewrite_inventory_refreshed',metadata:{generation:activeGeneration,libraryItemTotal:expectedLibraryTotal}});
      }
    }
    if(checkOnly){
      await guardInventory();
      const evidence=[];
      for(const slot of job.slots){
        const proof=protectedMap.get(slot.category+':'+slot.order);
        if(!proof)continue;
        let digest;
        if(slot.cachePath){
          if(!existsSync(slot.cachePath)||!slot.sha256||statSync(slot.cachePath).size!==slot.bytes||
             await sha256File(slot.cachePath)!==slot.sha256)throw Error('Protected cache changed: '+slot.name);
          digest=slot.sha256;
        }else{
          const bytes=await fetchImage(slot.url);
          const repr=bytes.representation||validateOriginalRepresentation(slot.url,bytes.ext);
          if(repr.status==='representation_changed'||(slot.sha256&&slot.sha256!==bytes.sha256))
            throw Error('Protected source representation/hash changed: '+slot.name);
          digest=bytes.sha256;
        }
        const found=await prove({...slot,sha256:digest},proof);
        evidence.push({name:slot.name,itemId:found.id,sha256:found.sha256,kind:proof.kind});
      }
      await guardInventory();
      return {status:'ready_partial_recovery',protected:evidence.length,
        pending:job.slots.length-evidence.length,evidence,eagleWrites:0};
    }
    // Prefetch ALL originals before the first irreversible Eagle write.
    // A zero-write recovery may reuse exact verified cache bytes; no Eagle writes are repeated.
    for(const slot of job.slots){
      const key=slot.category+':'+slot.order,protectedSlot=protectedMap.has(key);
      try{
        if(recoveryMode&&slot.cachePath){
          if(!existsSync(slot.cachePath)||!slot.sha256||statSync(slot.cachePath).size!==slot.bytes||
             await sha256File(slot.cachePath)!==slot.sha256)
            throw Error('Existing recovery cache changed; never overwrite or silently redownload');
          if(!protectedSlot&&slot.state!=='prefetched')
            recordJobEvent(root,job,{slotKey:key,event:'partial_prewrite_reset',
              metadata:{state:'prefetched',itemId:null,error:null}});
          continue;
        }
        if(resumeNoWrite&&slot.cachePath){
          if(!existsSync(slot.cachePath)||!slot.sha256||statSync(slot.cachePath).size!==slot.bytes||
             await sha256File(slot.cachePath)!==slot.sha256)
            throw Error('Existing V3 cache changed; never overwrite or silently redownload');
          if(slot.state!=='prefetched')
            recordJobEvent(root,job,{slotKey:key,event:'prewrite_guard_resumed_using_verified_cache',
              metadata:{state:'prefetched',error:null}});
          continue;
        }
        const bytes=await fetchImage(slot.url);
        const repr=bytes.representation||validateOriginalRepresentation(slot.url,bytes.ext);
        if(repr.status==='representation_changed')throw Error('CDN returned a different file representation');
        if(slot.sha256&&slot.sha256!==bytes.sha256)
          throw Error('CDN source hash changed from previously verified value');
        const cachePath=saveCacheFile(root,productId,slot,bytes);
        const metadata={sha256:bytes.sha256,cachePath,bytes:bytes.size,ext:bytes.ext,error:null,
          ...(repr.status==='server_encoded_differently'?{representationDeviation:repr}:{})};
        if(recoveryMode&&protectedSlot&&slot.state!=='planned'){
          // Preserve all old write/verification states; refresh only proven immutable source evidence.
          recordJobEvent(root,job,{slotKey:key,event:'protected_source_verified',metadata});
        }else if(recoveryMode&&slot.state!=='planned'){
          recordJobEvent(root,job,{slotKey:key,event:'partial_prewrite_reset',
            metadata:{...metadata,state:'prefetched',itemId:null}});
        }else if(resumeNoWrite&&slot.state==='needs_read_only_review')
          recordJobEvent(root,job,{slotKey:key,event:'prewrite_guard_resumed_after_safe_prefetch',
            metadata:{...metadata,state:'prefetched'}});
        else
          recordJobEvent(root,job,{slotKey:key,state:'prefetched',
            event:'original_bytes_verified',metadata});
      }catch(error){
        if(slot.state==='needs_read_only_review'||slot.state==='verified')
          recordJobEvent(root,job,{slotKey:key,event:'prefetch_still_failed',
            metadata:{error:String(error.message||error)}});
        else recordJobEvent(root,job,{slotKey:key,state:'needs_read_only_review',
            event:'prefetch_failed',metadata:{error:String(error.message||error)}});
        throw Error('V3 prefetch failed before Eagle writes: '+slot.name+' '+error.message);
      }
    }
    // Verify the full inventory and every previously submitted slot BEFORE any new write.
    // Even an unresolved historical/uncertain slot stops the entire product.
    if(checkInventory||recoveryMode)await guardInventory({allowRefresh:true});
    for(const slot of job.slots){
      const key=slot.category+':'+slot.order,proof=protectedMap.get(key);
      if(!proof)continue;
      try{
        const found=await prove(slot,proof);
        const resolution=slot.resolution==='reused'||found.name!==slot.name?'reused':'imported';
        if(slot.state==='prefetched')
          recordJobEvent(root,job,{slotKey:key,state:'matched',event:'protected_item_readback',
            metadata:{itemId:found.id,resolution}});
        if(slot.state!=='verified')
          recordJobEvent(root,job,{slotKey:key,state:'verified',event:'protected_item_verified',
            metadata:{itemId:found.id,sha256:found.sha256,resolution,error:null}});
        verifiedProtected.set(key,{...slot,verified:true,itemId:found.id,eagleName:found.name,
          filePath:found.filePath,sha256:found.sha256,resolution,
          savedWidth:found.width,savedHeight:found.height,ext:found.ext});
      }catch(error){
        recordJobEvent(root,job,{slotKey:key,event:'protected_readback_blocked',
          metadata:{error:String(error.message||error)}});
        throw Error('Protected slot not re-submitted; '+slot.name+': '+error.message);
      }
    }
    for(const slot of job.slots){
      const key=slot.category+':'+slot.order;
      if(verifiedProtected.has(key)){out.push(verifiedProtected.get(key));continue}
      const release=acquireLibraryLock(root,libraryPath);
      const folderId=folderIds[slot.category];
      try{
        if(index.info().activeGeneration!==activeGeneration)throw Error('Eagle fingerprint generation changed during operation');
        const actualCount=await checkLibrary();
        if(actualCount!==expectedLibraryTotal)throw Error('Eagle library changed since fingerprint indexing; safely stop before any new item_add');
        const match=await resolveV3ExactMatch({index,sha256:slot.sha256,folderId,getById,libraryPath});
        if(match){
          recordJobEvent(root,job,{slotKey:key,state:'matched',event:'exact_eagle_bytes_matched',
            metadata:{itemId:match.id,resolution:'reused'}});
          if(!match.folders.includes(folderId)){
            recordJobEvent(root,job,{slotKey:key,state:'reuse_link_intent',event:'eagle_folder_link_submitting',
              metadata:{itemId:match.id}});
            await linkFolders([match.id],[folderId]);
          }
          const verified=await verifyEagleById(match.id,{getById,libraryPath,expectedSha:slot.sha256,folderId});
          if(!verified)throw Error('Eagle folder link outcome uncertain; never retry link blindly');
          recordJobEvent(root,job,{slotKey:key,state:'verified',event:'reuse_physical_verified',
            metadata:{itemId:verified.id,sha256:verified.sha256,resolution:'reused'}});
          out.push({...slot,verified:true,itemId:verified.id,eagleName:verified.name,
            filePath:verified.filePath,sha256:verified.sha256,resolution:'reused',
            savedWidth:verified.width,savedHeight:verified.height,ext:verified.ext});
        }else{
          if(!maySubmitSlot(slot))throw Error('V3 slot may have been submitted; never auto resubmit');
          recordJobEvent(root,job,{slotKey:key,state:'import_intent',
            event:'single_eagle_import_submitting',metadata:{submitIntentRecorded:true}});
          const id=await importLocal({path:slot.cachePath,name:slot.name,folder:folderId,website:url});
          recordJobEvent(root,job,{slotKey:key,state:'import_acknowledged',event:'single_eagle_import_acknowledged',
            metadata:{itemId:id}});
          const verified=await verifyEagleById(id,{getById,libraryPath,expectedSha:slot.sha256,folderId});
          if(!verified)throw Error('Eagle import accepted but physical file/folder unverified; no retry');
          index.upsertVerified(verified);
          expectedLibraryTotal++;
          index.setLibraryItemTotal(expectedLibraryTotal);
          recordJobEvent(root,job,{slotKey:key,state:'verified',event:'single_eagle_import_verified',
            metadata:{itemId:id,sha256:verified.sha256,resolution:'imported'}});
          out.push({...slot,verified:true,itemId:id,eagleName:verified.name,
            filePath:verified.filePath,sha256:verified.sha256,resolution:'imported',
            savedWidth:verified.width,savedHeight:verified.height,ext:verified.ext});
        }
      }catch(error){
        if(slot.state!=='needs_read_only_review'&&slot.state!=='verified')
          recordJobEvent(root,job,{slotKey:key,state:'needs_read_only_review',
            event:'eagle_outcome_uncertain',metadata:{error:String(error.message||error),requestFailure:eagleFailureDetails(error)}});
        throw Error('V3 stop with journal; '+slot.name+': '+error.message);
      }finally{release()}
    }
    job.state='verified';
    recordJobEvent(root,job,{event:'all_slots_physically_verified'});
    return {status:'verified',job,images:out};
  }finally{index.close()}
}
