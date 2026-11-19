// Current Eagle truth: read classified physical items, never infer that the
// original receipt's itemId remains authoritative after an explicit repair.
// This module performs ONLY read-only Eagle RPCs and physical file hashing.
import {realpathSync,statSync,createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';

export function expectedProductItems(images, id) {
  if (!/^[0-9]{8,16}$/.test(String(id))) throw Error('Invalid product ID');
  if (!Array.isArray(images) || !images.length) throw Error('No expected product images');
  const seen = new Set();
  const byCategory = {main: [], detail: []};
  for (const x of images) {
    if (!x || !['main','detail'].includes(x.category) ||
        !Number.isInteger(x.order) || x.order < 1 ||
        typeof x.name !== 'string' ||
        !new RegExp('^(?:Tmall|Taobao)-' + id + '-' + x.category + '-[0-9]{3,4}$').test(x.name))
      throw Error('Unexpected expected image record: ' + String(x?.name));
    const suffix=Number(x.name.match(/-([0-9]{3,4})$/)?.[1]);
    if (suffix !== x.order || seen.has(x.name))
      throw Error('Duplicate/mismatched expected name: ' + x.name);
    seen.add(x.name);
    byCategory[x.category].push(x);
  }
  for (const [cat, group] of Object.entries(byCategory)) {
    group.sort((a,b)=>a.order-b.order);
    for (let i=0;i<group.length;i++) if (group[i].order!==i+1)
      throw Error('Missing/duplicate '+cat+' image order '+(i+1));
  }
  return byCategory;
}
function asItems(result) {
  if(Array.isArray(result))return result;
  if(Array.isArray(result?.items))return result.items;
  if(Array.isArray(result?.folders))return result.folders;
  throw Error('Unexpected Eagle collection');
}
export function findProductArchive(roots,productId,{rootName=null}={}) {
  const hits=[];
  for(const root of asItems(roots)){
    if(!/^天猫批量采集_\d{4}-\d{2}-\d{2}$/.test(root.name))continue;
    if(rootName && root.name!==rootName)continue;
    for(const product of root.children||[]){
      if(product.name!==String(productId))continue;
      if(!root.id||!product.id)throw Error('Eagle product folder has no ID');
      const folderOf=name=>{
        const found=(product.children||[]).filter(x=>x.name===name);
        if(found.length>1)throw Error('Duplicate '+name+' folder in Eagle product '+productId);
        return found[0]||null;
      };
      const main=folderOf('主图'),detail=folderOf('详情页');
      hits.push({rootName:root.name,rootId:root.id,productId:String(productId),
        productFolderId:product.id,mainFolderId:main?.id||null,detailFolderId:detail?.id||null});
    }
  }
  if(hits.length>1)throw Error('Ambiguous historical Eagle folders for '+productId+'; specify YYYY-MM-DD');
  return hits[0]||null;
}
export async function hashEagleFile(item) {
  if(!item?.id || typeof item.filePath!=='string'||!item.filePath)
    throw Error('Eagle item missing physical path or ID');
  const full=realpathSync(item.filePath);
  const normalized=full.replace(/\\/g,'/');
  const anchor='/images/'+item.id+'.info/';
  if(!normalized.toLowerCase().includes(anchor.toLowerCase()))
    throw Error('Eagle source path does not belong to its itemId: '+item.name);
  const st=statSync(full);
  if(!st.isFile()||st.size===0)throw Error('Eagle image empty or not a file '+item.name);
  const hash=createHash('sha256');
  for await (const chunk of createReadStream(full)) hash.update(chunk);
  return {filePath:full,bytes:st.size,sha256:hash.digest('hex')};
}
export async function listFolderItems(rpc,id) {
  if(!id)return [];
  const rows=[],limit=250;
  for(let offset=0;offset<=5000;offset+=limit){
    const group=asItems(await rpc('item_get',{folders:[id],limit,offset,fullDetails:true}));
    rows.push(...group);
    if(group.length<limit)return rows;
  }
  throw Error('Eagle folder exceeds safe readback pagination limit');
}
export async function readCurrentEagleProduct({rpc,productId,images,rootName=null,inspectFile=hashEagleFile}) {
  if(typeof rpc!=='function'||typeof inspectFile!=='function')throw Error('Missing Eagle reader');
  const groups=expectedProductItems(images,productId);
  const roots=await rpc('folder_get',{getAllHierarchy:true,fullDetails:true});
  const folder=findProductArchive(roots,productId,{rootName});
  const base={productId:String(productId),status:'folders_missing',
    rootName:folder?.rootName||rootName||null,folders:folder,
    expected:{main:groups.main.length,detail:groups.detail.length},
    counts:{main:0,detail:0},missing:[],invalid:[],formatChanges:[],unrelated:[],items:[]};
  if(!folder||!folder.mainFolderId||!folder.detailFolderId){
    base.missing=[...groups.main,...groups.detail].map(x=>x.name);
    return base;
  }
  const [actualMain,actualDetail]=await Promise.all([
    listFolderItems(rpc,folder.mainFolderId),listFolderItems(rpc,folder.detailFolderId)
  ]);
  for(const category of ['main','detail']){
    const fid=category==='main'?folder.mainFolderId:folder.detailFolderId;
    const list=category==='main'?actualMain:actualDetail;
    const seenIDs=new Set();
    for(const a of list){
      if(!a?.id||seenIDs.has(a.id))throw Error('Eagle returned duplicated/invalid itemId');
      seenIDs.add(a.id);
    }
    for(const image of groups[category]){
      const matches=list.filter(x=>x.name===image.name);
      if(matches.length===0){base.missing.push(image.name);continue;}
      if(matches.length>1){base.invalid.push({name:image.name,reason:'duplicate_exact_name'});continue;}
      const item=matches[0];
      if(!item.id||!(item.folders||[]).includes(fid)||!(item.width>0)||!(item.height>0)||
         item.isDeleted===true){
        base.invalid.push({name:image.name,reason:'invalid_item_metadata_or_folder'});
        continue;
      }
      try{
        const verified=await inspectFile(item);
        if(!verified?.filePath||!verified?.bytes||!verified?.sha256)
          throw Error('File inspection lacks path/size/SHA');
        const originalExt=String(image.ext||image.savedExt||'').toLowerCase();
        const actualExt=String(item.ext||'').toLowerCase();
        if(originalExt&&actualExt&&actualExt!==originalExt)
          base.formatChanges.push({name:image.name,originalExt,actualExt});
        base.items.push({id:item.id,name:item.name,category,order:image.order,ext:actualExt,
          width:item.width,height:item.height,folderId:fid,...verified});
        base.counts[category]++;
      }catch(e){base.invalid.push({name:image.name,reason:String(e.message||e).slice(0,220)});}
    }
    const names=new Set(groups[category].map(x=>x.name));
    for(const x of list) if(!names.has(x.name))
      base.unrelated.push({id:x.id,name:x.name,folder:category});
  }
  base.items.sort((a,b)=>(a.category==='main'?0:1)-(b.category==='main'?0:1)||a.order-b.order);
  base.status=base.missing.length===0&&base.invalid.length===0&&
    base.counts.main===base.expected.main&&base.counts.detail===base.expected.detail
      ? 'complete':'partial';
  return base;
}
