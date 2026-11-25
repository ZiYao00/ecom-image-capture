// Resolve a logical slot to a physically valid item already in its target folder.
// Never infer identity from a foreign Eagle filename alone.
import {readFileSync,statSync,createReadStream,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
export async function hashLocal(file){
 const st=statSync(file);
 if(!st.isFile()||st.size===0)throw Error('Invalid local source');
 const h=createHash('sha256');
 for await(const b of createReadStream(file))h.update(b);
 return {sha256:h.digest('hex'),bytes:st.size};
}

// Handle only the narrow case where Eagle itself explicitly returns the existing
// original itemId on a "Use Original" import, but did not link the item to the
// intended category folder. A stale URL match or ghost itemId is NOT sufficient.
export async function associateConfirmedReuse({missing,submitted,knownSources,readByIds,
  inspect,linkToFolder,folderIds,journal=async()=>{}}){
 if(!Array.isArray(missing)||!Array.isArray(submitted)||!knownSources||
    typeof readByIds!=='function'||typeof inspect!=='function'||typeof linkToFolder!=='function')
  throw Error('Invalid Eagle association dependencies');
 const results=[],pending=[];
 for(const slot of missing){
  const linkedCandidates=new Set(knownSources.get(slot.url)||[]);
  const eagleReturned=[...new Set(submitted.filter(x=>x?.name===slot.name)
    .map(x=>x.itemId||x.id).filter(x=>linkedCandidates.has(x)))];
  if(eagleReturned.length!==1){
   pending.push({name:slot.name,reason:eagleReturned.length?'ambiguous_returned_reuse':'no_explicit_original_id'});
   continue;
  }
  const id=eagleReturned[0],target=folderIds?.[slot.category];
  if(!target)throw Error('Eagle category folder missing for '+slot.name);
  const inspectItem=async()=>{
   const response=await readByIds([id]);
   const rows=Array.isArray(response)?response:response?.items||[];
   if(rows.length!==1||rows[0].id!==id||rows[0].isDeleted===true||
      !rows[0].width||!rows[0].height)throw Error('Returned reused item invalid '+id);
   const file=await inspect(rows[0]);
   if(!file?.sha256||!file.filePath||!file.bytes)throw Error('Reused original physical file missing '+id);
   return {item:rows[0],file};
  };
  const before=await inspectItem();
  if(!before.item.folders?.includes(target)){
   await journal({name:slot.name,originalItemId:id,folderId:target,status:'associating'});
   await linkToFolder([id],[target]);
  }
  const after=await inspectItem();
  if(!after.item.folders?.includes(target)||after.file.sha256!==before.file.sha256)
   throw Error('Reused asset folder association unverified: '+slot.name);
  results.push({...slot,itemId:id,verified:true,resolution:'reused',
   eagleName:after.item.name,filePath:after.file.filePath,sha256:after.file.sha256,
   ext:after.item.ext,savedWidth:after.item.width,savedHeight:after.item.height});
  await journal({name:slot.name,originalItemId:id,folderId:target,status:'verified'});
 }
 return {resolved:results,unresolved:pending};
}

export async function resolveReusedSlots({missing,candidates,localFallbacks=[],sourceDigests=new Map(),knownSources=new Map(),inspect}){
 if(!Array.isArray(missing)||!Array.isArray(candidates)||typeof inspect!=='function')
  throw Error('Invalid Eagle reuse resolution dependencies');
 const out=[],unresolved=[];
 const local=new Map(localFallbacks.map(x=>[x.name,x]));
 const verifiedItems=new Map();
 const verify=async item=>{
  if(!verifiedItems.has(item.id)){
   const x=await inspect(item);
   if(!x?.sha256||!x.filePath||!x.bytes)throw Error('Incomplete Eagle physical file evidence');
   verifiedItems.set(item.id,x);
  }
  return verifiedItems.get(item.id);
 };
 for(const slot of missing){
  const fallback=local.get(slot.name);
  let sourceDigest=sourceDigests.get(slot.name)||null,matchingByBytes=sourceDigest!==null;
   if(matchingByBytes&&!/^[a-f0-9]{64}$/.test(sourceDigest))throw Error('Invalid original source digest');
  if(fallback){
   if(fallback.category!==slot.category||fallback.order!==slot.order||!existsSync(fallback.file)){
    unresolved.push({name:slot.name,reason:'fallback_metadata_invalid'});continue;
   }
   const content=await hashLocal(fallback.file);
   if(content.sha256!==fallback.sha256||content.bytes!==fallback.size){
    unresolved.push({name:slot.name,reason:'fallback_hash_mismatch'});continue;
   }
   sourceDigest=content.sha256;matchingByBytes=true;
  }
  const known=new Set(knownSources.get(slot.url)||[]);
  const possibles=[];
  for(const candidate of candidates.filter(x=>x.category===slot.category)){
   if(!candidate.id||candidate.isDeleted===true||!(candidate.width>0)||!(candidate.height>0))
    continue;
   if(!matchingByBytes&&!known.has(candidate.id))continue;
     let physical;
     try{physical=await verify(candidate)}catch{continue;}
   if(matchingByBytes?physical.sha256===sourceDigest:known.has(candidate.id))
    possibles.push({item:candidate,physical});
  }
  const uniq=[...new Map(possibles.map(x=>[x.item.id,x])).values()];
  if(uniq.length!==1){
   unresolved.push({name:slot.name,reason:uniq.length===0?'no_proven_shared_item':'ambiguous_shared_items'});
   continue;
  }
  const x=uniq[0];
  out.push({...slot,itemId:x.item.id,verified:true,resolution:'reused',
   eagleName:x.item.name,filePath:x.physical.filePath,
   ext:x.item.ext||null,savedWidth:x.item.width,savedHeight:x.item.height,
   sha256:x.physical.sha256});
 }
 return {resolved:out,unresolved};
}

// Bounded read-only target-folder retries; never repeat an import. Only positive
// folder membership and physical identity count as evidence on either transport.
// Hash fallback reads at most ten unresolved source slots per product in memory.
export async function resolveV2ReuseWithReadback({missing,knownSources,folderIds,
  listMcp,listWeb=null,inspect,sourceDigest=null,budget={remaining:10},
  delays=[0,600,1500,3000],wait=ms=>new Promise(r=>setTimeout(r,ms))}){
  if(!Array.isArray(missing)||typeof listMcp!=='function'||typeof inspect!=='function')
    throw Error('Invalid V2 reuse readback dependencies');
  const resolved=[],blocked=new Map(),trace=[],digests=new Map();
  let pending=[...missing],webUsed=false,hasCandidates=false;
  const candidatesFor=async(reader,slots)=>{
    const cats=[...new Set(slots.map(x=>x.category))];
    const rows=await Promise.all(cats.map(async category=>{
      const id=folderIds?.[category];
      if(!id)throw Error('Missing target folder for reuse');
      const items=await reader(id);
      if(!Array.isArray(items))throw Error('Invalid folder readback');
      return items.filter(x=>x.folders?.includes(id)).map(x=>({...x,category}));
    }));
    return rows.flat();
  };
  const absorb=(proof,transport)=>{
    const ids=new Set(proof.resolved.map(x=>x.name));
    for(const x of proof.unresolved.filter(x=>x.reason==='ambiguous_shared_items'))blocked.set(x.name,x);
    resolved.push(...proof.resolved);
    if(transport==='web'&&proof.resolved.length)webUsed=true;
    pending=pending.filter(x=>!ids.has(x.name)&&!blocked.has(x.name));
  };
  for(let i=0;i<delays.length&&pending.length;i++){
    if(delays[i])await wait(delays[i]);
    for(const [transport,reader] of [['mcp',listMcp],['web',listWeb]]){
      if(!reader||!pending.length)continue;
      try{
        const rows=await candidatesFor(reader,pending);hasCandidates||=rows.length>0;
        const proof=await resolveReusedSlots({missing:pending,candidates:rows,knownSources,inspect});
        trace.push({attempt:i+1,transport,candidates:rows.length,resolved:proof.resolved.length});
        absorb(proof,transport);
      }catch(error){trace.push({attempt:i+1,transport,error:String(error.message||error).slice(0,160)});}
    }
  }
  if(sourceDigest&&pending.length&&hasCandidates){
    for(const slot of pending){
      if(!Number.isInteger(budget.remaining)||budget.remaining<=0)break;
      budget.remaining--;
      try{
        const value=await sourceDigest(slot);
        if(/^[a-f0-9]{64}$/.test(value||''))digests.set(slot.name,value);
      }catch(error){trace.push({transport:'source_hash',name:slot.name,error:String(error.message||error).slice(0,160)});}
    }
    if(digests.size){
      for(const [transport,reader] of [['web',listWeb],['mcp',listMcp]]){
        if(!reader||!pending.some(x=>digests.has(x.name)))continue;
        try{
          const slots=pending.filter(x=>digests.has(x.name));
          const rows=await candidatesFor(reader,slots);
          const proof=await resolveReusedSlots({missing:slots,candidates:rows,knownSources,sourceDigests:digests,inspect});
          trace.push({transport:transport+'_hash',candidates:rows.length,resolved:proof.resolved.length});
          absorb(proof,transport);
        }catch(error){trace.push({transport:transport+'_hash',error:String(error.message||error).slice(0,160)});}
      }
    }
  }
  return {resolved,unresolved:[...blocked.values(),...pending.map(x=>({name:x.name,reason:digests.has(x.name)?'source_hash_no_match':'no_proven_shared_item'}))],
    trace,webUsed,sourceHashes:digests.size};
}
