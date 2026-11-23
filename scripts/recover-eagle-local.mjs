#!/usr/bin/env node
// Recover only locally-verified, explicitly recorded missing images to Eagle.
// Each non-idempotent item_add is journaled BEFORE submission and never blindly retried.
import {readFileSync,existsSync,mkdirSync,writeFileSync,statSync,createReadStream} from 'node:fs';
import {resolve,join,dirname,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {eagleArchiveRpc} from './eagle-archive.mjs';
import {readCurrentEagleProduct,hashEagleFile} from './eagle-current.mjs';
import {acquireProductLock} from './capture-store.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const apply=args.includes('--apply'),id=args.find(x=>/^\d{8,16}$/.test(x));
if(!id||args.length!==2||!args.includes('--check')&&!args.includes('--apply'))
  throw Error('Usage: node scripts/recover-eagle-local.mjs <productId> --check|--apply');
const receiptFile=join(root,'data','runs','stable-'+id,'receipt.json');
if(!existsSync(receiptFile))throw Error('No capture receipt for '+id);
const receipt=JSON.parse(readFileSync(receiptFile,'utf8'));
if(receipt.productId!==id||!Array.isArray(receipt.images))throw Error('Invalid receipt');
const cfgPath=n=>join(root,'config',n);
const local=n=>existsSync(cfgPath(n))?JSON.parse(readFileSync(cfgPath(n),'utf8')):{};
const cfg={...local('local.example.json'),...local('local.json')};
const endpoint=process.env.EAGLE_MCP_URL||cfg.eagleMcpUrl;
if(!endpoint)throw Error('Eagle MCP unavailable');
const rpc=(name,a)=>eagleArchiveRpc(endpoint,name,a,name==='item_add'?90000:45000);
const journalFile=join(root,'data','recovery-eagle',id+'.json');
const journal=existsSync(journalFile)?JSON.parse(readFileSync(journalFile,'utf8')):{
  productId:id,status:'planned',createdAt:new Date().toISOString(),items:{}};
const save=()=>{
  mkdirSync(dirname(journalFile),{recursive:true});
  writeFileSync(journalFile,JSON.stringify(journal,null,2)+'\n','utf8');
};
const hash=async path=>{
  const s=statSync(path);
  if(!s.isFile()||s.size<=0)throw Error('Missing/empty local image '+path);
  const sha=createHash('sha256');
  for await(const part of createReadStream(path))sha.update(part);
  return {sha256:sha.digest('hex'),size:s.size};
};
const asItems=data=>Array.isArray(data)?data:(data?.items||[]);
const findExact=async name=>{
  const rows=asItems(await rpc('item_get',{keywords:[name],limit:100,offset:0,fullDetails:true}));
  if(rows.length>=100)throw Error('Eagle item search truncated: '+name);
  const found=rows.filter(x=>x.name===name);
  if(found.length>1)throw Error('Ambiguous Eagle duplicate name: '+name);
  return found[0]||null;
};
const getById=async itemId=>{
  const rows=asItems(await rpc('item_get',{ids:[itemId],fullDetails:true}));
  return rows.find(x=>x.id===itemId)||null;
};
const validateCandidate=async (item,candidate)=>{
  if(!item||item.name!==candidate.name||item.isDeleted===true||!(item.width>0)||!(item.height>0))
    return null;
  const m=await hashEagleFile(item);
  if(m.sha256!==candidate.sha256)throw Error('Image content hash mismatch: '+candidate.name);
  return {id:item.id,...m,folders:item.folders||[]};
};
let unlock=null;
try{
  if(apply)unlock=acquireProductLock(root,id);
  const snapshot=await readCurrentEagleProduct({rpc,productId:id,images:receipt.images,rootName:receipt.archive?.rootName||null});
  if(snapshot.status==='complete'){
    console.log(JSON.stringify({operation:'recover-eagle-local',status:'already_complete',id,counts:snapshot.counts,changed:false},null,2));
    process.exitCode=0;
  } else {
    if(!snapshot.folders?.mainFolderId||!snapshot.folders?.detailFolderId)
      throw Error('Eagle category folders missing; finish directory migration first');
    if(snapshot.invalid.length)throw Error('Invalid existing Eagle item(s): '+JSON.stringify(snapshot.invalid));
    const fallbacks=new Map((receipt.directFallback||[]).map(x=>[x.name,x]));
    const candidates=[];
    for(const name of snapshot.missing){
      const original=receipt.images.find(x=>x.name===name);
      const localItem=fallbacks.get(name);
      if(!original||!localItem||localItem.category!==original.category||localItem.order!==original.order)
        throw Error('Verified local fallback not available for '+name);
      const file=resolve(localItem.file);
      const output=resolve(receipt.destination);
      const rel=relative(output,file);
      if(rel.startsWith('..'+sep)||rel==='..'||rel===''||rel.startsWith('/')||rel.startsWith('\\'))
        throw Error('Fallback path escapes recorded output: '+name);
      const actual=await hash(file);
      if(actual.sha256!==localItem.sha256||actual.size!==localItem.size)
        throw Error('Local fallback integrity mismatch: '+name);
      candidates.push({name,file,sha256:actual.sha256,category:original.category,
        target:original.category==='main'?snapshot.folders.mainFolderId:snapshot.folders.detailFolderId});
    }
    const ready=[];
    for(const candidate of candidates){
      const found=await findExact(candidate.name);
      if(found)await validateCandidate(found,candidate);
      const step=journal.items[candidate.name];
      if(step?.status==='submitting' && !found)
        throw Error('Previous Eagle submission uncertain, manual review only: '+candidate.name);
      ready.push({...candidate,existingId:found?.id||null});
    }
    if(!apply){
      console.log(JSON.stringify({operation:'recover-eagle-local',status:'ready',id,
        missing:ready.map(x=>({name:x.name,existingId:x.existingId,localValidated:true})),
        changed:false,applyCommand:'node scripts/recover-eagle-local.mjs '+id+' --apply'},null,2));
    }else{
      journal.status='in_progress';save();
      for(const candidate of ready){
        let item=await findExact(candidate.name);
        if(item)await validateCandidate(item,candidate);
        if(!item){
          journal.items[candidate.name]={status:'submitting',file:candidate.file,
            expectedSha256:candidate.sha256,startedAt:new Date().toISOString()};
          save();
          const output=asItems(await rpc('item_add',{
            folders:[candidate.target],
            items:[{source:{type:'path',path:candidate.file},name:candidate.name}]
          }));
          if(output.length!==1||output[0]?.success!==true)throw Error('Eagle did not acknowledge '+candidate.name);
          const itemId=output[0].itemId||output[0].id;
          if(!itemId)throw Error('Eagle returned no itemId for '+candidate.name);
          journal.items[candidate.name].itemId=itemId;save();
          for(const delay of [300,900,1600,3000]){
            await new Promise(ok=>setTimeout(ok,delay));
            item=await getById(itemId);
            if(item)break;
          }
          if(!item)throw Error('Eagle returned ID but physical item is missing: '+candidate.name);
        }
        let verified=await validateCandidate(item,candidate);
        if(!verified.folders.includes(candidate.target)){
          journal.items[candidate.name]={...journal.items[candidate.name],status:'classifying',itemId:item.id};save();
          await rpc('item_add_to_folders',{ids:[item.id],folders:[candidate.target]});
          item=await getById(item.id);
          verified=await validateCandidate(item,candidate);
          if(!verified.folders.includes(candidate.target))throw Error('Folder classification not verified: '+candidate.name);
        }
        journal.items[candidate.name]={status:'verified',itemId:item.id,
          sha256:verified.sha256,filePath:verified.filePath,finishedAt:new Date().toISOString()};
        save();
      }
      const after=await readCurrentEagleProduct({rpc,productId:id,images:receipt.images,
        rootName:receipt.archive?.rootName||null});
      journal.status=after.status==='complete'?'complete':'incomplete';
      journal.completedAt=new Date().toISOString();save();
      console.log(JSON.stringify({operation:'recover-eagle-local',status:journal.status,id,
        classified:after.counts,missing:after.missing,invalid:after.invalid,
        journal:journalFile,originalReceiptChanged:false},null,2));
      if(after.status!=='complete')process.exitCode=2;
    }
  }
}catch(e){
  if(apply&&journal.status==='in_progress'){journal.status='needs_read_only_review';journal.error=String(e.message||e);save();}
  console.error(JSON.stringify({operation:'recover-eagle-local',status:'needs_read_only_review',
    error:String(e.message||e),noAutomaticRetry:true},null,2));
  process.exitCode=2;
}finally{unlock?.();}
