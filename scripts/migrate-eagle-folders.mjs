#!/usr/bin/env node
// PC-local Eagle folder migration: move existing folder IDs, never re-import images.
import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {eagleArchiveRpc,ECOM_ARCHIVE_ROOT} from './eagle-archive.mjs';
import {planUnifiedFolderMigration} from './eagle-migration-core.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const flags=process.argv.slice(2);
if(flags.length!==1||!['--check','--apply'].includes(flags[0]))
  throw Error('Usage: node scripts/migrate-eagle-folders.mjs --check|--apply');
const apply=flags[0]==='--apply';
const local=(p)=>existsSync(p)?JSON.parse(readFileSync(p,'utf8')):{};
const cfg={...local(join(root,'config','local.example.json')),...local(join(root,'config','local.json'))};
const endpoint=process.env.EAGLE_MCP_URL||cfg.eagleMcpUrl;
if(!endpoint)throw Error('Eagle MCP URL missing');
const rpc=(name,args)=>eagleArchiveRpc(endpoint,name,args);
const folders=async()=>{const x=await rpc('folder_get',{getAllHierarchy:true,fullDetails:true});if(!Array.isArray(x))throw Error('Invalid Eagle folder tree');return x;};
const snapshot=await folders();
const plan=planUnifiedFolderMigration(snapshot);
if(!apply||plan.status!=='ready'){
  console.log(JSON.stringify({operation:'migrate-eagle-folders',mode:apply?'apply':'check',
    ...plan,changed:false},null,2));process.exit(0);
}
const itemIds=async folderId=>{
  const rows=await rpc('item_get',{folders:[folderId],fullDetails:false,limit:1000,offset:0});
  const list=Array.isArray(rows)?rows:(rows.items||[]);
  if(!Array.isArray(list)||list.length>=1000)throw Error('Ambiguous/paginated Eagle folder '+folderId);
  return list.map(x=>x.id).sort();
};
// Preserve category folder IDs and their item assignments. No original image bytes move.
const baseline=[];
for(const p of plan.products){
  baseline.push({...p,mainIds:await itemIds(p.mainFolderId),detailIds:await itemIds(p.detailFolderId)});
}
const dir=join(root,'data','migrations');
mkdirSync(dir,{recursive:true});
const file=join(dir,'unified-eagle-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,6)+'.json');
const state={status:'planned',startedAt:new Date().toISOString(),targetRoot:ECOM_ARCHIVE_ROOT,
  anchor:plan.anchor,baseline,steps:[],changed:false};
const save=()=>writeFileSync(file,JSON.stringify(state,null,2)+'\n','utf8');
save();
const locate=(roots,id)=>{
  const walk=(nodes,parent=null)=>{
    for(const x of nodes){if(x.id===id)return {node:x,parent};const hit=walk(x.children||[],x);if(hit)return hit;}
    return null;
  };return walk(roots);
};
const assertPreserved=async()=>{
  const live=await folders();
  const target=live.find(x=>x.id===plan.anchor.id&&x.name===ECOM_ARCHIVE_ROOT);
  if(!target)throw Error('Unified root does not match original anchor');
  for(const p of baseline){
    const liveFolder=locate(live,p.id);
    if(!liveFolder||liveFolder.parent?.id!==(p.nested?p.parentId:plan.anchor.id)||
      liveFolder.node.name!==p.name)
      throw Error('Product folder missing or moved incorrectly: '+p.name);
    const names=liveFolder.node.children||[];
    if(names.find(x=>x.name==='主图')?.id!==p.mainFolderId ||
       names.find(x=>x.name==='详情页')?.id!==p.detailFolderId)
      throw Error('Category IDs changed: '+p.name);
    if(JSON.stringify(await itemIds(p.mainFolderId))!==JSON.stringify(p.mainIds) ||
       JSON.stringify(await itemIds(p.detailFolderId))!==JSON.stringify(p.detailIds))
      throw Error('Eagle item folder association changed: '+p.name);
  }
  return target;
};
try {
  if(plan.anchor.rename){
    state.steps.push({action:'rename_root',id:plan.anchor.id,from:plan.anchor.name,to:ECOM_ARCHIVE_ROOT,status:'submitting'});save();
    await rpc('folder_update',{folders:[{id:plan.anchor.id,name:ECOM_ARCHIVE_ROOT}]});
    const renamed=locate(await folders(),plan.anchor.id);
    if(renamed?.node.name!==ECOM_ARCHIVE_ROOT)throw Error('Root rename result uncertain');
    state.steps.at(-1).status='verified';save();
  }
  for(const p of plan.move){
    const live=locate(await folders(),p.id);
    if(live?.parent?.id!==p.sourceRootId)throw Error('Source folder changed: '+p.name);
    state.steps.push({action:'move_product',id:p.id,from:p.sourceRootId,to:plan.anchor.id,status:'submitting'});save();
    await rpc('folder_update',{folders:[{id:p.id,parentId:plan.anchor.id}]});
    const moved=locate(await folders(),p.id);
    if(moved?.parent?.id!==plan.anchor.id)throw Error('Move result uncertain: '+p.name);
    state.steps.at(-1).status='verified';save();
  }
  await assertPreserved();
  state.status='complete';state.changed=true;state.completedAt=new Date().toISOString();save();
  console.log(JSON.stringify({operation:'migrate-eagle-folders',status:'complete',
    rootName:ECOM_ARCHIVE_ROOT,products:plan.products.length,moved:plan.move.length,
    renamed:plan.anchor.rename,legacyRootsNotDeleted:plan.legacyRoots.filter(x=>x.id!==plan.anchor.id).map(x=>x.name),
    snapshot:file,verifiedPreserved:true},null,2));
}catch(e){
  state.status='needs_read_only_review';state.error=String(e?.message||e);save();
  console.error(JSON.stringify({operation:'migrate-eagle-folders',status:state.status,error:state.error,
    snapshot:file,automaticRetry:false},null,2));process.exitCode=2;
}
