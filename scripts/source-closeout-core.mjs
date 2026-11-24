// Plan/execute source-folder closeout from an immutable snapshot, using only folder associations.
import {canonicalProductUrl} from './capture-store.mjs';
const ident=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{8,64}$/.test(x);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export function locateSourceFolder(tree,name){
 if(!['AA','BB'].includes(name))throw Error('Source folder must be AA or BB');
 const roots=Array.isArray(tree)?tree:tree?.folders;
 if(!Array.isArray(roots))throw Error('Malformed Eagle folder tree');
 const matches=[];
 const walk=nodes=>{for(const n of nodes){if(typeof n.name==='string'&&n.name.toUpperCase()===name)matches.push(n);if(Array.isArray(n.children))walk(n.children)}};
 walk(roots);
 if(matches.length!==1||!ident(matches[0].id))throw Error('Source folder name must resolve uniquely: '+name);
 return matches[0].id;
}
export async function planSourceCloseout({folderName,folderId,libraryPath,items,resolveProduct,inspectSource}){
 if(!['AA','BB'].includes(folderName)||!ident(folderId)||!libraryPath||!Array.isArray(items))throw Error('Invalid source closeout input');
 const ready=[],pending=[],ids=new Set(),products=new Map();
 for(const item of items){
  if(!ident(item.id)||ids.has(item.id))throw Error('Duplicate/invalid source item');
  ids.add(item.id);
  try{
   if(!item.folders?.includes(folderId)||item.isDeleted===true)throw Error('Source membership not proven');
   const source=await inspectSource(item);
   if(!digest(source?.sha256))throw Error('Source bytes not verified');
   const url=item.url||item.website;
   const identity=canonicalProductUrl(url);
   const cacheKey=identity.productId+':'+(identity.skuId||'');
   if(!products.has(cacheKey))products.set(cacheKey,await resolveProduct(identity));
   const p=products.get(cacheKey);
   if(p?.status!=='complete'||p.skuId!==identity.skuId||!ident(p.main)||!ident(p.detail))throw Error('Product/SKU delivery not verified');
   const linked=(p.slots||[]).filter(s=>s.itemId===item.id);
   if(linked.some(s=>s.sha256!==source.sha256))throw Error('Source hash conflicts with product map');
   const target=linked.length?p[linked[0].category]:p.main;
   if(!ident(target)||target===folderId)throw Error('Unsafe target folder');
   ready.push({sourceId:item.id,productId:identity.productId,skuId:identity.skuId,
     url:identity.url,sha256:source.sha256,beforeFolders:[...item.folders],target});
  }catch(e){pending.push({sourceId:item.id,reason:String(e.message||e)});}
 }
 return {schemaVersion:1,folderName,folderId,libraryPath,sourceIds:[...ids],ready,pending};
}
export function assertSourceProof(row,proof,folderId,{requireSource=false,requireTarget=false,removed=false}={}){
 if(!proof||proof.sourceId!==row.sourceId||proof.productId!==row.productId||proof.skuId!==row.skuId||
  proof.sha256!==row.sha256||proof.url!==row.url||proof.target!==row.target||
  !Array.isArray(proof.folders)||row.beforeFolders.filter(x=>x!==folderId).some(x=>!proof.folders.includes(x)))
  throw Error('Source identity/bytes/target or original associations changed: '+row.sourceId);
 if(requireSource&&!proof.folders.includes(folderId))throw Error('Source association no longer present: '+row.sourceId);
 if(requireTarget&&!proof.folders.includes(row.target))throw Error('Target association not verified: '+row.sourceId);
 if(removed&&proof.folders.includes(folderId))throw Error('Source association removal not verified: '+row.sourceId);
 return proof;
}
export async function applySourceCloseout({plan,libraryPath,folderId,readProof,link,unlink,log,priorIntents=[]}){
 if(plan?.schemaVersion!==1||plan.libraryPath.toLowerCase()!==libraryPath.toLowerCase()||plan.folderId!==folderId||
    !Array.isArray(plan.ready)||!Array.isArray(plan.sourceIds)||new Set(plan.ready.map(x=>x.sourceId)).size!==plan.ready.length||
    plan.ready.some(x=>!plan.sourceIds.includes(x.sourceId)))throw Error('Source closeout snapshot identity changed');
 const checked=[];
 // Check the entire snapshot before the first mutation. Newly added items are not part of it.
 for(const row of plan.ready){
  const proof=assertSourceProof(row,await readProof(row),folderId);
  for(const intent of priorIntents.filter(x=>x.sourceId===row.sourceId)){
   if(intent.action==='link'&&!proof.folders.includes(intent.folderId)||
      intent.action==='unlink'&&proof.folders.includes(intent.folderId))
    throw Error('Previous association write outcome unresolved; never replay: '+row.sourceId);
  }
  if(!proof.folders.includes(folderId)&&!proof.folders.includes(row.target))
   throw Error('Source removed without target proof: '+row.sourceId);
  checked.push(row);
 }
 let linked=0,removed=0,alreadyComplete=0;
 for(const row of checked){
  let proof=assertSourceProof(row,await readProof(row),folderId);
  if(!proof.folders.includes(folderId)){
   assertSourceProof(row,proof,folderId,{requireTarget:true,removed:true});
   alreadyComplete++;log({event:'already_complete',sourceId:row.sourceId});continue;
  }
  if(!proof.folders.includes(row.target)){
   log({event:'intent',action:'link',sourceId:row.sourceId,folderId:row.target});
   await link(row.sourceId,row.target);
   proof=assertSourceProof(row,await readProof(row),folderId,{requireSource:true,requireTarget:true});
   log({event:'verified',action:'link',sourceId:row.sourceId,folderId:row.target});linked++;
  }
  assertSourceProof(row,proof,folderId,{requireSource:true,requireTarget:true});
  log({event:'intent',action:'unlink',sourceId:row.sourceId,folderId});
  await unlink(row.sourceId,folderId);
  assertSourceProof(row,await readProof(row),folderId,{requireTarget:true,removed:true});
  log({event:'verified',action:'unlink',sourceId:row.sourceId,folderId});removed++;
 }
 return {status:plan.pending.length?'partial':'complete',planned:checked.length,linked,removed,alreadyComplete,pending:plan.pending.length,deletedFiles:0};
}
