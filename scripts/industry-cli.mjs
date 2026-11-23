#!/usr/bin/env node
// Product-level industry classification; no image downloads/imports and no receipt mutations.
import{readFileSync,existsSync,mkdirSync,writeFileSync}from'node:fs';
import{createHash,randomUUID}from'node:crypto';
import{join,resolve,dirname}from'node:path';
import{fileURLToPath}from'node:url';
import{readRegistry,updateProductClassification}from'./capture-store.mjs';
import{classifyProductTitle,classifyManual,INDUSTRIES,isConfidentClassification,
  industryLabel,subcategoryLabel}from'./industry-core.mjs';
import{syncIndustryEagle}from'./industry-eagle.mjs';
import{moveIndustryProduct}from'./eagle-industry-move.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [mode,...args]=process.argv.slice(2);
const isId=s=>/^\d{8,16}$/.test(s||'');
const sourceOf=id=>{
  const p=join(root,'data','runs','stable-'+id,'receipt.json');
  if(!existsSync(p))return{title:null};
  const r=JSON.parse(readFileSync(p,'utf8'));
  if(r.productId!==id)throw Error('Receipt ID mismatch: '+id);
  return{title:r.title||null};
};
const listTargets=id=>{
  const records=readRegistry(root).products;
  if(id&&!isId(id))throw Error('Invalid product ID');
  if(id&&!Object.hasOwn(records,id))throw Error('Product not registered: '+id);
  return id?[records[id]]:Object.values(records);
};
const display=(p,estimated)=>{
  const c=estimated||p.classification||null;
  return{id:p.productId,title:sourceOf(p.productId).title,
    industry:c?.industryCode||null,industryName:industryLabel(c?.industryCode),
    subcategory:c?.subcategoryCode||null,subcategoryName:subcategoryLabel(c?.industryCode,c?.subcategoryCode),
    classStatus:c?.status||'missing',source:c?.source||null,manualLocked:c?.manualLocked===true,
    evidence:c?.evidence||[],captureStatus:p.status,workflowStatus:p.workflowStatus||'incomplete'};
};
const emit=(result,code=0)=>{console.log(JSON.stringify(result,null,2));process.exitCode=code};
function backupRegistryOnce(){
  const input=join(root,'data','captures.json'),bytes=readFileSync(input),sha256=createHash('sha256').update(bytes).digest('hex');
  const dir=join(root,'runtime','industry-backups');
  mkdirSync(dir,{recursive:true});
  const file=join(dir,'captures-before-industry-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8)+'.json');
  writeFileSync(file,bytes,{flag:'wx'});
  if(createHash('sha256').update(readFileSync(file)).digest('hex')!==sha256)
    throw Error('Failed to verify industry registry safety backup');
  return{path:file,bytes:bytes.length,sha256};
}
try{
  if(mode==='--check'){
    if(args.length>1)throw Error('Use --check [productId]');
    const items=listTargets(args[0]).map(p=>{
      const current=p.classification;
      const value=current?.manualLocked?current:classifyProductTitle(sourceOf(p.productId).title);
      return {...display(p,value),changeNeeded:JSON.stringify(value)!==JSON.stringify(current)};
    });
    const count={};
    for(const x of items)count[x.industryName||'待分类']=(count[x.industryName||'待分类']||0)+1;
    emit({status:'read_only_preflight',total:items.length,byIndustry:count,
      manualLocked:items.filter(x=>x.manualLocked).length,
      autoConfirmed:items.filter(x=>x.classStatus==='auto_confirmed').length,
      needsReview:items.filter(x=>x.classStatus==='needs_review').length,
      eligibleForEagle:items.filter(x=>x.workflowStatus==='complete'&&x.classStatus!=='needs_review').length,
      items,eagleWrites:0,registryModified:false});
  }else if(mode==='--apply'){
    if(args.length>1)throw Error('Use --apply [productId]');
    const items=listTargets(args[0]),backup=backupRegistryOnce(),out=[];
    for(const p of items){
      const current=p.classification;
      if(current?.manualLocked){out.push({...display(p),changed:false});continue}
      const c=classifyProductTitle(sourceOf(p.productId).title);
      const changed=JSON.stringify(current)!==JSON.stringify(c);
      if(changed)await updateProductClassification(root,p.productId,c);
      out.push({...display(p,c),changed});
    }
    const counts={};for(const x of out)counts[x.industryName||'待分类']=(counts[x.industryName||'待分类']||0)+1;
    emit({status:'applied_registry_only',total:out.length,byIndustry:counts,
      changed:out.filter(x=>x.changed).length,backup,items:out,eagleWrites:0});
  }else if(mode==='--set'){
    if(args.length!==3||!isId(args[0]))throw Error('Use --set <productId> <industryCode> <subcategoryCode>');
    const [id,industry,subcategory]=args;
    listTargets(id);
    const c=classifyManual(industry,subcategory);
    const backup=backupRegistryOnce();
    const updated=await updateProductClassification(root,id,c);
    let folderMove;
    try{folderMove=await moveIndustryProduct(root,id)}
    catch(e){emit({status:'manual_saved_folder_pending',product:display(updated),backup,
      error:String(e.message||e),noImageReimport:true},2);process.exit(2)}
    let eagleSync;
    try{eagleSync=await syncIndustryEagle(root,id)}
    catch(e){eagleSync={status:'needs_read_only_review',error:String(e.message||e)}}
    emit({status:eagleSync.status==='needs_read_only_review'?'manual_saved_eagle_pending':'manual_saved',
      product:display(updated),folderMove,eagleSync,backup},eagleSync.status==='needs_read_only_review'?2:0);
  }else if(mode==='--sync-eagle'){
    if(args.length>1)throw Error('Use --sync-eagle [productId]');
    const results=[];
    for(const p of listTargets(args[0])){
      try{results.push(await syncIndustryEagle(root,p.productId))}
      catch(e){
        results.push({productId:p.productId,status:'needs_read_only_review',error:String(e.message||e)});
        // No batch retries after uncertain Eagle metadata writes.
        emit({status:'stopped_safe',results,remainingNotAttempted:!args[0],noImageReimport:true},2);
        process.exit(2);
      }
    }
    emit({status:'eagle_sync_checked',total:results.length,
      synced:results.filter(x=>x.status==='synced').length,
      pending:results.filter(x=>x.status==='pending_long_image').length,
      other:results.filter(x=>!['synced','pending_long_image'].includes(x.status)).length,
      results,noImageReimport:true});
  }else if(mode==='--list'){
    if(args.length>1||args[0]&& !Object.hasOwn(INDUSTRIES,args[0]))
      throw Error('Use --list [industryCode]');
    const items=listTargets().filter(x=>!args[0]||x.classification?.industryCode===args[0]).map(x=>display(x));
    emit({status:'listed',total:items.length,items});
  }else throw Error('Usage: industry --check [ID] | --apply [ID] | --sync-eagle [ID] | --set ID industry subcategory | --list [industry]');
}catch(e){console.error(JSON.stringify({status:'failed',error:String(e.message||e),originalReceiptsModified:false,noImageReimport:true}));process.exitCode=2}
