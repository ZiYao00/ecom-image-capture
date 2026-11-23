#!/usr/bin/env node
// Eagle physical folder migration. --check is read-only, --apply moves one product at a time.
import {readFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readRegistry} from './capture-store.mjs';
import {eagleArchiveRpc} from './eagle-archive.mjs';
import {planIndustryMoves,moveIndustryProduct,rollbackIndustryProduct} from './eagle-industry-move.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [mode,selection,confirmation]=process.argv.slice(2);
const idOk=s=>/^\d{8,16}$/.test(s||'');
if(!['--check','--apply','--rollback'].includes(mode)||process.argv.length>5||
  (confirmation!==undefined&&(mode!=='--rollback'||confirmation!=='--apply'))||
  (selection!==undefined&&selection!=='--all'&&!idOk(selection)))
 throw Error('Usage: industry-folders --check [ID] | --apply <ID>|--all | --rollback <ID> [--apply]');
if(mode==='--apply'&&!selection)throw Error('An explicit product ID or --all is required for folder moves');
if(mode==='--rollback'&&!idOk(selection))throw Error('Rollback requires a single product ID');
const cfg=JSON.parse(readFileSync(join(root,'config','local.json'),'utf8'));
const rpc=(name,args)=>eagleArchiveRpc(cfg.eagleMcpUrl,name,args);
if(mode==='--rollback'){
 const report=await rollbackIndustryProduct(root,selection,{rpc,mode:confirmation?'apply':'check'});
 console.log(JSON.stringify({...report,noImageImport:true},null,2));
 process.exit(0);
}
const tree=await rpc('folder_get',{getAllHierarchy:true,fullDetails:true});
const plan=planIndustryMoves(tree,readRegistry(root),{
  productId:selection&&selection!=='--all'?selection:null});
if(mode==='--check'){
 console.log(JSON.stringify({status:'read_only',mode,total:plan.total,toMove:plan.toMove,
   alreadyCorrect:plan.alreadyCorrect,industries:plan.industries.map(x=>({name:x.name,id:x.id})),
   tasks:plan.tasks.map(x=>({productId:x.productId,folderId:x.folderId,
     originalParentId:x.parentId,targetIndustry:x.targetIndustryName,
     targetParentId:x.targetParentId,state:x.state,
     mainFolderId:x.mainFolderId,detailFolderId:x.detailFolderId})),
   eagleWrites:0},null,2));
 process.exit(0);
}
const target=selection==='--all'?plan.tasks:plan.tasks.filter(x=>x.productId===selection);
const results=[];
for(const row of target){
 try{
  const result=await moveIndustryProduct(root,row.productId,{rpc});
  results.push(result);
 }catch(error){
  console.error(JSON.stringify({status:'stopped_safe',mode,results,
    blockedProductId:row.productId,error:String(error.message||error),
    remainingProducts:target.length-results.length,noImageImport:true,
    neverAutoRetryUncertainFolderWrite:true},null,2));
  process.exit(2);
 }
}
console.log(JSON.stringify({status:'complete',mode,processed:results.length,
 moved:results.filter(x=>x.status==='moved').length,
 alreadyCorrect:results.filter(x=>x.status==='already_correct').length,
 results,noImageImport:true},null,2));
