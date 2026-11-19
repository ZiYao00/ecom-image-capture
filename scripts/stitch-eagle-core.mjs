// Opt-in Agent stitching directly from Eagle original paths; never exports
// duplicate source slices. Import only resulting JPEG parts to product root.
import {existsSync,mkdirSync,writeFileSync,readFileSync,createReadStream,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {readCurrentEagleProduct,listFolderItems,hashEagleFile} from './eagle-current.mjs';
import {stitchImages,modeWidth,resizedHeight,partitionImages} from './stitch-core.mjs';

export const digestObject=obj=>createHash('sha256').update(JSON.stringify(obj)).digest('hex');
export function stitchPartName(productId,width,part,total,prefix='Tmall') {
  return prefix+'-'+productId+'-detail-long-'+width+'w'+(total>1?'-part'+part:'');
}
export function planEagleStitch(snapshot,{width=null,maxHeight=65500}={}) {
  if(snapshot?.status!=='complete')throw Error('Eagle current archive is not complete');
  const detail=snapshot.items.filter(x=>x.category==='detail').sort((a,b)=>a.order-b.order);
  if(!detail.length||detail.length!==snapshot.expected.detail)throw Error('No complete Eagle detail set');
  const target=width===null?modeWidth(detail.map(x=>x.width)):Number(width);
  if(!Number.isInteger(target)||target<32||target>8192)throw Error('Invalid stitch width');
  const structure=partitionImages(detail.map((x,index)=>({index,height:resizedHeight(x.width,x.height,target)})),maxHeight);
  const prefix=detail[0].name.split('-')[0];
  if(detail.some(x=>!x.name.startsWith(prefix+'-')))throw Error('Mixed source name prefixes');
  const names=structure.parts.map((_,i)=>stitchPartName(snapshot.productId,target,i+1,structure.parts.length,prefix));
  const inputSignature=digestObject({productId:snapshot.productId,target,maxHeight,
    inputs:detail.map(x=>({id:x.id,order:x.order,sha256:x.sha256}))});
  return {width:target,maxHeight,height:structure.totalHeight,partCount:names.length,
    partHeights:structure.parts.map(x=>x.height),names,inputSignature,detail};
}
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
function asItems(x){if(Array.isArray(x))return x;if(Array.isArray(x?.items))return x.items;throw Error('Invalid Eagle item response')}
function makeStatus(snapshot,plan,status,extra={}) {
  return {status,productId:snapshot.productId,rootName:snapshot.rootName,
    sourceMode:'eagle_only',sourceCount:plan.detail.length,
    exportedSourceFiles:0,width:plan.width,height:plan.height,partCount:plan.partCount,
    partNames:plan.names,inputSignature:plan.inputSignature,
    folderId:snapshot.folders.productFolderId,...extra};
}
export async function stitchEagleProduct({
  rpc,productId,images,rootName=null,width=null,maxHeight=65500,apply=false,
  outputRoot,inspectFile=hashEagleFile,build=stitchImages,wait=sleep
}) {
  const snapshot=await readCurrentEagleProduct({rpc,productId,images,rootName,inspectFile});
  if(snapshot.status!=='complete')
    return {status:'incomplete_eagle_sources',productId,expected:snapshot.expected,
      counts:snapshot.counts,missing:snapshot.missing,invalid:snapshot.invalid,rootName:snapshot.rootName};
  const plan=planEagleStitch(snapshot,{width,maxHeight});
  const parent=join(resolve(outputRoot),String(productId));
  const runDir=join(parent,plan.inputSignature.slice(0,16)+'-'+plan.width+'w');
  const marker=join(runDir,'submission.json');
  const productItems=await listFolderItems(rpc,snapshot.folders.productFolderId);
  const collisions=productItems.filter(x=>plan.names.includes(x.name));
  if(collisions.length){
    const full=[];
    for(const found of collisions){
      try{const checked=await inspectFile(found);full.push({
        id:found.id,name:found.name,bytes:checked.bytes,sha256:checked.sha256,
        width:found.width,height:found.height})}
      catch(e){full.push({id:found.id,name:found.name,invalid:String(e.message||e)})}
    }
    // A repeat of OUR fully recorded run is idempotent. Unrelated/manual
    // same-name output remains an explicit conflict, never silently reused.
    if(existsSync(marker)){
      const state=JSON.parse(readFileSync(marker,'utf8'));
      const proven=state.status==='complete'&&state.inputSignature===plan.inputSignature&&
        full.length===plan.partCount&&state.parts?.length===plan.partCount&&
        state.parts.every(part=>full.some(item=>
          item.id===part.itemId&&item.name===part.name&&item.sha256===part.sha256&&
          item.width===part.width&&item.height===part.height));
      if(proven)return makeStatus(snapshot,plan,'already_complete',{existing:full,marker,stageDir:runDir});
    }
    return makeStatus(snapshot,plan,'existing_eagle_targets_no_retry',{existing:full,stageDir:runDir});
  }
  if(existsSync(marker)){
    const before=JSON.parse(readFileSync(marker,'utf8'));
    return makeStatus(snapshot,plan,'previous_attempt_no_retry',{
      attemptStatus:before.status,stageDir:runDir,marker});
  }
  if(!apply)return makeStatus(snapshot,plan,'ready',{stageDir:runDir});
  if(existsSync(runDir))throw Error('Existing staging directory without marker: inspect before proceeding '+runDir);
  const built=build({files:plan.detail.map(x=>x.filePath),outputDir:runDir,
    width:plan.width,maxHeight:plan.maxHeight});
  if(built.status!=='ok'||built.parts.length!==plan.partCount||
     built.height!==plan.height||built.width!==plan.width)
    throw Error('Generated stitch output does not match planned dimensions');
  mkdirSync(runDir,{recursive:true});
  const prepared=[];
  for(let i=0;i<built.parts.length;i++){
    const b=built.parts[i];
    if(b.width!==plan.width||b.height!==plan.partHeights[i])
      throw Error('Built part dimensions mismatch at '+i);
    // Staging files are outside Eagle; hash them directly before import.
    const hash=createHash('sha256');
    for await(const chunk of createReadStream(b.file))hash.update(chunk);
    prepared.push({name:plan.names[i],file:b.file,width:b.width,height:b.height,
      bytes:statSync(b.file).size,sha256:hash.digest('hex'),itemId:null,status:'prepared'});
  }
  const state={status:'prepared',productId,rootName:snapshot.rootName,
    folderId:snapshot.folders.productFolderId,inputSignature:plan.inputSignature,
    stageDir:runDir,createdAt:new Date().toISOString(),parts:prepared};
  const record=()=>writeFileSync(marker,JSON.stringify(state,null,2)+'\n','utf8');
  writeFileSync(marker,JSON.stringify(state,null,2)+'\n',{flag:'wx'});
  for(let i=0;i<prepared.length;i++){
    const part=prepared[i];
    state.status='submitting';
    part.status='submitting';record();
    const added=asItems(await rpc('item_add',{
      folders:[snapshot.folders.productFolderId],
      items:[{source:{type:'path',path:part.file},name:part.name}]
    }));
    if(added.length!==1 || added[0].success!==true)throw Error('Eagle import not acknowledged for '+part.name);
    const id=added[0].itemId||added[0].id;
    if(!id)throw Error('Eagle import acknowledged without itemId');
    part.itemId=id;
    record();
    let found=null;
    for(const delay of [300,850,1800,3000]){
      await wait(delay);
      const list=asItems(await rpc('item_get',{ids:[id],fullDetails:true}));
      const matched=list.filter(x=>x.id===id&&x.name===part.name);
      if(matched.length>1)throw Error('Duplicate itemId/name after Eagle import');
      if(matched.length===1){
        const item=matched[0];
        if((item.folders||[]).includes(snapshot.folders.productFolderId)&&
           item.width===part.width&&item.height===part.height) {
          try{const verified=await inspectFile(item);
            if(verified.sha256===part.sha256)found={...verified,item};
          }catch{}
        }
      }
      if(found)break;
    }
    if(!found)throw Error('Eagle import returned but physical file/sha not verified: '+part.name);
    part.status='verified';part.eaglePath=found.filePath;state.status='partial_verified';
    record();
  }
  state.status='complete';state.completedAt=new Date().toISOString();record();
  return makeStatus(snapshot,plan,'complete',{stageDir:runDir,marker,
    parts:prepared.map(x=>({name:x.name,id:x.itemId,width:x.width,height:x.height,bytes:x.bytes,sha256:x.sha256})),
    built:built.status});
}
