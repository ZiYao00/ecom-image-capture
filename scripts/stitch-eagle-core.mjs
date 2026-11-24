// Opt-in Agent stitching directly from Eagle original paths; never exports
// duplicate source slices. Import only resulting JPEG parts to product root.
import {existsSync,mkdirSync,writeFileSync,readFileSync,createReadStream,statSync,renameSync,realpathSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
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
  const readPart=async(part)=>{
    const candidates=collisions.filter(x=>x.name===part.name);
    if(candidates.length!==1)return null;
    const item=candidates[0];
    if((part.itemId&&item.id!==part.itemId)||!item.id||
       item.width!==part.width||item.height!==part.height||
       !item.folders?.includes(snapshot.folders.productFolderId))return null;
    try{
      const proof=await inspectFile(item);
      return proof.sha256===part.sha256?{item,proof}:null;
    }catch{return null}
  };
  const stageHash=async(file)=>{
    const actual=realpathSync(file),rel=relative(realpathSync(runDir),actual);
    if(!rel||rel==='..'||rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))||isAbsolute(rel))
      throw Error('Stitch part is outside its recorded stage directory');
    const stat=statSync(actual);
    if(!stat.isFile()||!stat.size)throw Error('Missing prepared stitch part');
    const hash=createHash('sha256');for await(const chunk of createReadStream(actual))hash.update(chunk);
    return {bytes:stat.size,sha256:hash.digest('hex')};
  };
  const rendering=join(runDir,'rendering.json');
  let state,prepared;
  const record=()=>{
    const tmp=marker+'.'+randomUUID()+'.tmp';
    writeFileSync(tmp,JSON.stringify(state,null,2)+'\n',{flag:'wx'});
    renameSync(tmp,marker);
  };
  if(existsSync(marker)){
    state=JSON.parse(readFileSync(marker,'utf8'));
    if(state.productId!==productId||state.inputSignature!==plan.inputSignature||
       state.folderId!==snapshot.folders.productFolderId||state.rootName!==snapshot.rootName||
       !['prepared','submitting','partial_verified','complete'].includes(state.status)||
       !Array.isArray(state.parts)||state.parts.length!==plan.partCount)
      throw Error('Existing stitch marker does not match the current verified input');
    prepared=state.parts;
    let tail=false,uncertain=0;
    for(let i=0;i<prepared.length;i++){
      const part=prepared[i];
      if(part.name!==plan.names[i]||part.width!==plan.width||part.height!==plan.partHeights[i]||
        !/^[a-f0-9]{64}$/.test(part.sha256||'')||!Number.isInteger(part.bytes)||part.bytes<=0||
        !['prepared','submitting','verified'].includes(part.status)||
        (part.status==='prepared'&&part.itemId)||(part.status==='verified'&&!part.itemId)||
        (part.status==='verified'&&tail)||(part.status==='submitting'&&(tail||uncertain++)))
        throw Error('Invalid or ambiguous persisted stitch submission sequence');
      if(part.status!=='verified')tail=true;
      if(state.status==='complete'&&part.status!=='verified')throw Error('Complete stitch marker contains unverified part');
    }
    // Reconcile all protected writes BEFORE authorizing the remaining prepared parts.
    for(const part of prepared){
      if(part.status==='prepared'){
        if(collisions.some(x=>x.name===part.name))return makeStatus(snapshot,plan,'existing_eagle_targets_no_retry',{marker,stageDir:runDir});
        const physical=await stageHash(part.file);
        if(physical.bytes!==part.bytes||physical.sha256!==part.sha256)throw Error('Prepared stitch part changed');
      }else{
        const found=await readPart(part);
        if(!found)return makeStatus(snapshot,plan,'previous_attempt_no_retry',{attemptStatus:state.status,blockedPart:part.name,marker,stageDir:runDir});
        part.itemId=found.item.id;part.status='verified';part.eaglePath=found.proof.filePath;
      }
    }
    if(prepared.every(x=>x.status==='verified')){
      if(apply&&state.status!=='complete'){state.status='complete';state.completedAt=new Date().toISOString();record()}
      return makeStatus(snapshot,plan,'already_complete',{existing:prepared.map(x=>({id:x.itemId,name:x.name,sha256:x.sha256,bytes:x.bytes,width:x.width,height:x.height})),marker,stageDir:runDir});
    }
    if(!apply)return makeStatus(snapshot,plan,'ready_resume',{marker,stageDir:runDir});
    state.status=prepared.some(x=>x.status==='verified')?'partial_verified':'prepared';record();
  }else{
    if(collisions.length)return makeStatus(snapshot,plan,'existing_eagle_targets_no_retry',{
      existing:collisions.map(x=>({id:x.id,name:x.name,width:x.width,height:x.height})),stageDir:runDir});
    const renderIdentity={schemaVersion:1,productId,folderId:snapshot.folders.productFolderId,inputSignature:plan.inputSignature};
    if(existsSync(runDir)){
      if(!existsSync(rendering)||JSON.stringify(JSON.parse(readFileSync(rendering,'utf8')))!==JSON.stringify(renderIdentity))
        throw Error('Existing staging directory without verifiable pre-write render marker: '+runDir);
    }
    if(!apply)return makeStatus(snapshot,plan,'ready',{stageDir:runDir});
    mkdirSync(runDir,{recursive:true});
    if(!existsSync(rendering))writeFileSync(rendering,JSON.stringify(renderIdentity)+'\n',{flag:'wx'});
    // A failed rendering attempt has not submitted any image. Preserve its
    // files and render into a new subdirectory rather than overwriting them.
    const attemptDir=join(runDir,'render-'+randomUUID());
    const built=build({files:plan.detail.map(x=>x.filePath),outputDir:attemptDir,
      width:plan.width,maxHeight:plan.maxHeight});
    if(built.status!=='ok'||built.parts.length!==plan.partCount||built.height!==plan.height||built.width!==plan.width)
      throw Error('Generated stitch output does not match planned dimensions');
    prepared=[];
    for(let i=0;i<built.parts.length;i++){
      const b=built.parts[i];
      if(b.width!==plan.width||b.height!==plan.partHeights[i])throw Error('Built part dimensions mismatch at '+i);
      const proof=await stageHash(b.file);
      prepared.push({name:plan.names[i],file:b.file,width:b.width,height:b.height,
        bytes:proof.bytes,sha256:proof.sha256,itemId:null,status:'prepared'});
    }
    state={status:'prepared',productId,rootName:snapshot.rootName,
      folderId:snapshot.folders.productFolderId,inputSignature:plan.inputSignature,
      stageDir:runDir,createdAt:new Date().toISOString(),parts:prepared};
    writeFileSync(marker,JSON.stringify(state,null,2)+'\n',{flag:'wx'});
  }
  for(let i=0;i<prepared.length;i++){
    const part=prepared[i];
    if(part.status==='verified')continue;
    if(part.status!=='prepared')throw Error('Uncertain stitch write must not be re-submitted');
    const stageProof=await stageHash(part.file);
    if(stageProof.bytes!==part.bytes||stageProof.sha256!==part.sha256)throw Error('Staged part changed before write');
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
    built:'ok'});
}
