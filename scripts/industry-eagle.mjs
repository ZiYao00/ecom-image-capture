// Eagle industry tags. Never copies, renames, relocates or re-imports an original.
// The classification in captures.json is authoritative; physical industry folders are the main view.
// Legacy smart folder definitions/readers are retained only for read-only inspection.
import {existsSync,readFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {eagleArchiveRpc} from './eagle-archive.mjs';
import {readRegistry,updateProductClassification} from './capture-store.mjs';
import {acquireLibraryLock} from './v3-job-state.mjs';
import {isConfidentClassification,classifyProductTitle,industryTag,subcategoryTag,isManagedTag,
  industryLabel,subcategoryLabel} from './industry-core.mjs';

export const EAGLE_INDUSTRY_MARKER='ecom-image-capture:industry-v1:';
const shortWait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function smartFolderSpecs(classification){
  if(!isConfidentClassification(classification))throw Error('Cannot publish an ambiguous industry');
  const {industryCode:i,subcategoryCode:s}=classification;
  const parentTag=industryTag(i),childTag=subcategoryTag(i,s);
  const top={name:'采集行业｜'+industryLabel(i),description:EAGLE_INDUSTRY_MARKER+i,
    iconColor:'blue',conditions:[{match:'AND',boolean:'TRUE',
      rules:[{property:'tags',method:'union',value:[parentTag]}]}]};
  const child={name:subcategoryLabel(i,s),description:EAGLE_INDUSTRY_MARKER+i+'/'+s,
    iconColor:'purple',conditions:[{match:'AND',boolean:'TRUE',
      rules:[{property:'tags',method:'union',value:[parentTag]},
        {property:'tags',method:'union',value:[childTag]}]}]};
  return {top,child,tags:[parentTag,childTag]};
}

export async function eagleWebAPI(route,{method='GET',body=null,base='http://127.0.0.1:41595',fetchFn=fetch}={}){
  const parsed=new URL(route,'http://eagle.local');
  if(parsed.origin!=='http://eagle.local'||!/^\/(?:smartFolder|item)\/[a-zA-Z]+$/.test(parsed.pathname))
    throw Error('Unsupported industry API path');
  if(parsed.pathname.startsWith('/smartFolder/')&&
    (method.toUpperCase()!=='GET'||body!==null||!['/smartFolder/get','/smartFolder/getRules','/smartFolder/getItems'].includes(parsed.pathname)))
    throw Error('Industry smart folders are retired; only read-only inspection is supported');
  const response=await fetchFn(new URL('/api/v2'+route,base).href,{
    method,...(body!==null?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),
    signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error('Eagle API HTTP '+response.status+' '+route);
  const data=await response.json();
  if(data?.status!=='success')throw Error('Eagle API '+route+': '+String(data?.message||'unexpected status'));
  return data.data;
}
export async function listSmartFolders({api=eagleWebAPI}={}){
  const all=[],seen=new Set();
  const pageSize=100;
  for(let offset=0;offset<=1000;offset+=pageSize){
    const result=await api('/smartFolder/get?offset='+offset+'&limit='+pageSize);
    const roots=Array.isArray(result)?result:result?.data;
    if(!Array.isArray(roots))throw Error('Malformed Eagle smart folder list');
    const walk=(items,parent=null)=>{for(const folder of items){
      if(!folder?.id)throw Error('Invalid Eagle smart folder identity');
      if(!seen.has(folder.id)){
        seen.add(folder.id);all.push({...folder,_parent:folder.parent||parent});
      }
      if(Array.isArray(folder.children)&&folder.children.length)
        walk(folder.children,folder.id);
    }};
    walk(roots);
    if(roots.length<pageSize){
      if(!Array.isArray(result)&&Number.isInteger(result.total)&&offset+roots.length<result.total)
        throw Error('Eagle smart folder pagination incomplete');
      return all;
    }
  }
  throw Error('Eagle smart folder count exceeds guarded pagination limit');
}
export async function eagleSmartFolderRules({api=eagleWebAPI}={}){
  const rules=await api('/smartFolder/getRules');
  if(!rules?.tags?.methods?.includes('union')||rules.tags.valueType!=='string_array')
    throw Error('Eagle smart folders do not support expected tag set filters');
  return rules;
}
export function findOwnedSmartFolder(folders,spec,parentId=null){
  const candidates=folders.filter(x=>x.name===spec.name&&
    (x._parent||x.parent||null)===(parentId||null));
  if(candidates.length>1)throw Error('Duplicate industry smart folders: '+spec.name);
  const item=candidates[0]||null;
  if(item&&item.description!==spec.description)
    throw Error('Existing Eagle smart folder belongs to another owner: '+spec.name);
  if(item&&JSON.stringify(item.conditions)!==JSON.stringify(spec.conditions))
    throw Error('Owned Eagle smart folder conditions changed; manual review required: '+spec.name);
  return item;
}
export async function readEagleImage(id,{api=eagleWebAPI}={}){
  if(!/^[A-Za-z0-9_-]{8,64}$/.test(id||''))throw Error('Invalid Eagle representative ID');
  const result=await api('/item/get?id='+encodeURIComponent(id));
  const items=Array.isArray(result)?result:result?.data;
  if(!Array.isArray(items))throw Error('Malformed Eagle item get');
  const match=items.filter(x=>x.id===id&&!x.isDeleted);
  if(match.length>1)throw Error('Duplicate Eagle ID');
  return match[0]||null;
}
async function checkedImage(id,{api=eagleWebAPI}={}){
  for(const delay of [0,350,900,1600]){
    if(delay)await shortWait(delay);
    const item=await readEagleImage(id,{api});
    if(item)return item;
  }
  throw Error('Eagle representative item not readable: '+id);
}
export function planIndustryTags(currentTags,desiredTags){
  const managed=(currentTags||[]).filter(isManagedTag);
  return{add:desiredTags.filter(x=>!managed.includes(x)),
    remove:managed.filter(x=>!desiredTags.includes(x))};
}
async function verifyTags(id,desired,{api=eagleWebAPI}={}){
  for(const delay of [0,400,1000,2400]){
    if(delay)await shortWait(delay);
    const item=await checkedImage(id,{api});
    const current=new Set(item.tags||[]);
    if(desired.every(x=>current.has(x)) &&
      !(item.tags||[]).some(x=>isManagedTag(x)&&!desired.includes(x)))return item;
  }
  throw Error('Industry Eagle tags did not reach verified state; do not repeat write blindly');
}
export async function tagIndustryRepresentative(id,classification,{rpc,api=eagleWebAPI,journal=()=>{}}={}){
  if(typeof rpc!=='function')throw Error('Eagle tag API is required');
  if(!isConfidentClassification(classification))throw Error('Cannot publish an ambiguous industry');
  const desired=[industryTag(classification.industryCode),
    subcategoryTag(classification.industryCode,classification.subcategoryCode)];
  let item=await checkedImage(id,{api});
  const before=[...(item.tags||[])];
  const action=planIndustryTags(before,desired);
  if(action.add.length){
    journal('eagle_tag_add_intent',{id,tags:action.add,before});
    await rpc('item_add_tags',{ids:[id],tags:action.add});
    journal('eagle_tag_add_acknowledged',{id,tags:action.add});
  }
  if(action.remove.length){
    // Only this project's explicit namespaced industry tags may ever be removed.
    item=await checkedImage(id,{api});
    const confirmedRemoval=action.remove.filter(tag=>(item.tags||[]).includes(tag));
    if(confirmedRemoval.length){
      journal('eagle_tag_remove_intent',{id,tags:confirmedRemoval});
      await rpc('item_remove_tags',{ids:[id],tags:confirmedRemoval});
      journal('eagle_tag_remove_acknowledged',{id,tags:confirmedRemoval});
    }
  }
  item=await verifyTags(id,desired,{api});
  return{status:'verified',id,tags:desired,added:action.add,removed:action.remove,
    preservedUnmanagedTags:before.filter(x=>!isManagedTag(x)).every(x=>item.tags.includes(x))};
}
export async function getSmartFolderItems(id,{api=eagleWebAPI}={}){
  const data=await api('/smartFolder/getItems?smartFolderId='+encodeURIComponent(id));
  const items=Array.isArray(data)?data:data?.data;
  if(!Array.isArray(items))throw Error('Malformed smart folder member response');
  return items;
}
export function verifyRepresentativeFromProject(root,id){
  const check=spawnSync(process.execPath,[join(root,'scripts','verify-live-product.mjs'),
    id,'--check'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:2*1024*1024});
  if(check.status!==0)throw Error('Product archive/long image not complete: '+id+
    ' '+String(check.stderr||check.stdout).slice(-180));
  const result=JSON.parse(check.stdout);
  if(result.status!=='complete'||!Array.isArray(result.longParts)||!result.longParts.length)
    throw Error('Verified product has no long image');
  const representative=result.longParts[0];
  if(!new RegExp('^(?:Tmall|Taobao)-'+id+'-detail-long-750w').test(representative.name)||
    !/^[a-f0-9]{64}$/.test(representative.sha256))
    throw Error('Invalid Eagle long-image representative identity');
  return representative;
}
export async function syncIndustryEagle(root,productId,{api=eagleWebAPI,rpc=null,
  verifyRepresentative=verifyRepresentativeFromProject}={}){
  const registry=readRegistry(root),record=registry.products[productId];
  if(!record||!isConfidentClassification(record.classification))
    return{status:'skipped_no_confirmed_classification',productId};
  if(record.workflowStatus!=='complete')
    return{status:'pending_long_image',productId};
  const verified=verifyRepresentative(root,productId);
  const cfg=JSON.parse(readFileSync(join(root,'config','local.json'),'utf8'));
  const call=rpc||(async(name,args)=>eagleArchiveRpc(cfg.eagleMcpUrl,name,args));
  const eagle=await call('get_app_info',{});
  if(!eagle?.libraryPath)throw Error('Current Eagle library path unavailable');
  const release=acquireLibraryLock(root,eagle.libraryPath);
  const audit=join(root,'data','industry-sync',productId+'.events.jsonl');
  const log=(event,data)=>{mkdirSync(dirname(audit),{recursive:true});
    appendFileSync(audit,JSON.stringify({at:new Date().toISOString(),event,...data})+'\n')};
  try{
    const current=await checkedImage(verified.itemId,{api});
    if(current.name!==verified.name||!Array.isArray(current.folders))
      throw Error('Representative name/folders differ from the independent proof');
    const tagged=await tagIndustryRepresentative(verified.itemId,record.classification,{rpc:call,api,journal:log});
    if(!tagged.preservedUnmanagedTags)throw Error('Unrelated Eagle tags unexpectedly changed');
    log('industry_tags_verified',{id:verified.itemId,tags:tagged.tags,smartFolders:'retired'});
    return{status:'synced',productId,representativeId:verified.itemId,
      industry:record.classification.industryCode,subcategory:record.classification.subcategoryCode,
      tagStatus:tagged.status,smartFolderIds:[],smartFolders:'retired',verified:true};
  }finally{release()}
}

// A catalog classification failure must NEVER downgrade a completed capture.
// Called after captureSummary/verify-live has already committed the normal product status.
export async function syncIndustryAfterProductComplete(root,productId){
  try{
  let product=readRegistry(root).products[productId];
  if(!product)return{status:'skipped_unregistered',productId};
  if(!product.classification){
    const file=join(root,'data','runs','stable-'+productId,'receipt.json');
    if(!existsSync(file))return{status:'pending_missing_receipt',productId};
    const receipt=JSON.parse(readFileSync(file,'utf8'));
    if(receipt.productId!==productId)throw Error('Industry receipt product ID mismatch');
    const next=classifyProductTitle(receipt.title);
    product=await updateProductClassification(root,productId,next);
  }
  if(!isConfidentClassification(product.classification))
    return{status:'pending_classification_review',productId};
  if(product.workflowStatus!=='complete')
    return{status:'pending_long_image',productId};
  try{
    return await syncIndustryEagle(root,productId);
  }catch(error){
    return{status:'needs_read_only_review',productId,error:String(error.message||error),
      captureUnchanged:true,noImageReimport:true};
  }
  }catch(error){
    return{status:'needs_read_only_review',productId,error:String(error.message||error),
      captureUnchanged:true,noImageReimport:true};
  }
}
