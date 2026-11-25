import test from 'node:test';
import assert from 'node:assert/strict';
import {importEagleInBatches} from '../scripts/eagle-batch.mjs';
import {verifyEaglePhysicalFile,hashEagleFile} from '../scripts/eagle-current.mjs';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveReusedSlots,associateConfirmedReuse,resolveV2ReuseWithReadback} from '../scripts/eagle-reuse-resolution.mjs';
test('Eagle Use Original resolves a ghost acknowledgement by an existing physical ID in target folder',async()=>{
 const url='https://gw.alicdn.com/tfs/same-original.png';
 const logical={category:'detail',order:1,name:'Tmall-891544196832-detail-001',url,website:'https://detail.tmall.com/item.htm?id=891544196832'};
 const original={id:'ORIGINALITEMID01',name:'Tmall-947780804552-detail-022',
  category:'detail',filePath:'D:/mock/ORIGINALITEMID01.info/shared.png',
  folders:['DETAILFOLDER01'],width:1125,height:231,ext:'png'};
 const index=new Map([[url,['ORIGINALITEMID01']]]);
 let addCalls=0,requested=null;
 const result=await importEagleInBatches([logical],{
  folderIds:{main:'MAINFOLDER01',detail:'DETAILFOLDER01'},
  add:async items=>{addCalls++;requested=items;return [{itemId:'GHOSTITEMID1234',name:logical.name,success:true}]},
  read:async()=>[],
  exists:()=>true,
  delays:[0],
  resolveReused:async ({unverified})=>resolveReusedSlots({
   missing:unverified,candidates:[original],knownSources:index,
   inspect:async()=>({filePath:original.filePath,sha256:'f'.repeat(64),bytes:400})
  })
 });
 assert.equal(addCalls,1);
 assert.deepEqual(requested[0].folders,['DETAILFOLDER01']);
 assert.equal(result.groups[0].status,'verified');
 assert.equal(result.groups[0].reused,1);
 assert.equal(result.records[0].resolution,'reused');
 assert.equal(result.records[0].itemId,original.id);
 assert.equal(result.records[0].name,logical.name);
 assert.equal(result.records[0].eagleName,original.name);
 assert.equal(result.issues.length,0);
});
test('Use Original may return the existing Eagle itemId directly, despite its different global filename',async()=>{
 const url='https://gw.alicdn.com/tfs/public-card.png';
 const src={name:'Tmall-891544196832-detail-038',url,category:'detail',order:38,website:'https://detail.tmall.com/item.htm?id=891544196832'};
 const original={id:'EXISTINGORIGINAL01',name:'Tmall-947780804552-detail-022',category:'detail',
  folders:['DETAIL01'],filePath:'D:/images/EXISTINGORIGINAL01.info/public.png',
  width:1125,height:231,ext:'png'};
 const result=await importEagleInBatches([src],{
  add:async()=>[{itemId:original.id,name:src.name,success:true}],
  read:async()=>[original],exists:()=>true,delays:[0],
  resolveReused:async ({unverified})=>resolveReusedSlots({
   missing:unverified,candidates:[original],
   knownSources:new Map([[url,[original.id]]]),
   inspect:async()=>({filePath:original.filePath,bytes:123,sha256:'d'.repeat(64)})
  })
 });
 assert.equal(result.groups[0].status,'verified');
 assert.equal(result.groups[0].reused,1);
 assert.equal(result.records[0].itemId,original.id);
 assert.equal(result.issues.length,0);
});

test('Eagle returned original ID may be linked to the correct folder exactly once',async()=>{
 const slot={name:'Tmall-891544196832-detail-038',
  url:'https://gw.alicdn.com/tfs/original.png',category:'detail',order:38};
 const item={id:'ORIGINAL_SHARED_01',name:'Tmall-947780804552-detail-022',
  folders:['OTHERDETAIL'],width:1125,height:231,ext:'png'};
 let writes=0,steps=[];
 const result=await associateConfirmedReuse({
  missing:[slot],submitted:[{itemId:item.id,name:slot.name,success:true}],
  knownSources:new Map([[slot.url,[item.id]]]),
  readByIds:async()=>[{...item,folders:[...item.folders]}],
  inspect:async()=>({sha256:'a'.repeat(64),filePath:'X:/images/ORIGINAL_SHARED_01.info/a.png',bytes:123}),
  linkToFolder:async(ids,folders)=>{writes++;assert.deepEqual(ids,[item.id]);item.folders.push(...folders)},
  folderIds:{main:'MAIN',detail:'TARGETDETAIL'},
  journal:async step=>steps.push(step.status)
 });
 assert.equal(writes,1);
 assert.deepEqual(steps,['associating','verified']);
 assert.equal(result.resolved.length,1);
 assert.equal(result.resolved[0].itemId,item.id);
 assert.equal(result.unresolved.length,0);
});
test('no explicit original ID means no unverified Eagle association write',async()=>{
 const slot={name:'Tmall-891544196832-detail-038',
  url:'https://gw.alicdn.com/tfs/original.png',category:'detail',order:38};
 let writes=0;
 const result=await associateConfirmedReuse({
  missing:[slot],submitted:[{itemId:'GHOSTITEM0000',name:slot.name,success:true}],
  knownSources:new Map([[slot.url,['ORIGINALITEM01']]]),
  readByIds:async()=>{throw Error('Should not query unproven item')},
  inspect:async()=>{throw Error('Should not inspect unproven item')},
  linkToFolder:async()=>{writes++},
  folderIds:{main:'MAIN',detail:'TARGET'}
 });
 assert.equal(writes,0);assert.equal(result.resolved.length,0);
 assert.equal(result.unresolved[0].reason,'no_explicit_original_id');
});

test('an unlinked or ambiguous reuse candidate never becomes success',async()=>{
 const r=await resolveReusedSlots({
  missing:[{name:'Tmall-891544196832-detail-001',url:'https://test/img',category:'detail',order:1}],
  candidates:[{id:'ORIGINALITEMID01',category:'detail',width:1,height:1}],
  knownSources:new Map([['https://test/img',['OTHERID00000000']]]),
  inspect:async()=>({filePath:'present',sha256:'f'.repeat(64),bytes:1})
 });
 assert.equal(r.resolved.length,0);
 assert.equal(r.unresolved[0].reason,'no_proven_shared_item');
});

const slot={name:'Tmall-675779438802-detail-001',category:'detail',order:1,url:'https://gw.alicdn.com/tfs/shared.jpg'};
const original={id:'ORIGINALITEM01',name:'old-detail-001',folders:['DETAIL'],filePath:'old-file',width:10,height:20,ext:'jpg'};
const proof=async item=>({filePath:item.filePath,sha256:'a'.repeat(64),bytes:120});
test('V2 folder readback retries delayed association and never needs another import',async()=>{
 let reads=0,hashes=0;
 const result=await resolveV2ReuseWithReadback({missing:[slot],knownSources:new Map([[slot.url,[original.id]]]),folderIds:{detail:'DETAIL'},
  listMcp:async()=>++reads===1?[]:[original],inspect:proof,sourceDigest:async()=>{hashes++;return 'a'.repeat(64)},delays:[0,1],wait:async()=>{}});
 assert.equal(reads,2);assert.equal(hashes,0);assert.equal(result.resolved[0].itemId,original.id);assert.equal(result.unresolved.length,0);
});
test('V2 uses Web readback when MCP has a ghost or delayed folder result',async()=>{
 const result=await resolveV2ReuseWithReadback({missing:[slot],knownSources:new Map([[slot.url,[original.id]]]),folderIds:{detail:'DETAIL'},
  listMcp:async()=>[],listWeb:async()=>[original],inspect:proof,delays:[0]});
 assert.equal(result.webUsed,true);assert.equal(result.resolved[0].itemId,original.id);
});
test('V2 hash fallback is unique, folder scoped and shares a bounded product budget',async()=>{
 const budget={remaining:1};let hashes=0;
 const args={missing:[slot],knownSources:new Map(),folderIds:{detail:'DETAIL'},listMcp:async()=>[original,{...original,id:'OTHER1234',folders:['OTHER']}],inspect:proof,
   sourceDigest:async()=>{hashes++;return 'a'.repeat(64)},budget,delays:[0]};
 const first=await resolveV2ReuseWithReadback(args);assert.equal(first.resolved[0].itemId,original.id);
 const second=await resolveV2ReuseWithReadback(args);assert.equal(second.resolved.length,0);assert.equal(hashes,1);assert.equal(budget.remaining,0);
 const ambiguous=await resolveV2ReuseWithReadback({...args,budget:{remaining:1},listMcp:async()=>[original,{...original,id:'OTHER1234'}]});
 assert.equal(ambiguous.resolved.length,0);assert.equal(ambiguous.unresolved[0].reason,'ambiguous_shared_items');
});
test('V2 metadata-only acknowledgment with missing file enters reuse proof before halt',async()=>{
 let adds=0;
 const result=await importEagleInBatches([slot],{add:async()=>{adds++;return [{id:'GHOSTITEM001',name:slot.name,success:true}]},
   read:async()=>[{id:'GHOSTITEM001',name:slot.name,filePath:'missing-file',width:10,height:20,ext:'jpg'}],
   exists:p=>p==='old-file',delays:[0],resolveReused:async({unverified})=>resolveV2ReuseWithReadback({
     missing:unverified,knownSources:new Map([[slot.url,[original.id]]]),folderIds:{detail:'DETAIL'},listMcp:async()=>[original],inspect:proof,delays:[0]})});
 assert.equal(adds,1);assert.equal(result.groups[0].status,'verified');assert.equal(result.records[0].itemId,original.id);assert.equal(result.issues.length,0);
});

test('V2 actual native physical paths pass before reuse, while foreign or empty files fail',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ecom-native-path-')),id='NATIVEITEM1234';
 const dir=join(root,'images',id+'.info');mkdirSync(dir,{recursive:true});
 const filePath=join(dir,'asset.jpg');writeFileSync(filePath,Buffer.from('physical source'));
 const physical=verifyEaglePhysicalFile({id,filePath});
 assert.equal(physical.bytes,15);
 assert.equal((await hashEagleFile({id,filePath})).bytes,15);
 assert.throws(()=>verifyEaglePhysicalFile({id:'OTHERITEM1234',filePath}),/does not belong/);
 const empty=join(dir,'empty.jpg');writeFileSync(empty,'');
 assert.throws(()=>verifyEaglePhysicalFile({id,filePath:empty}),/empty or not a file/);
 let reuseCalls=0,adds=0;
 const result=await importEagleInBatches([slot],{
   add:async()=>{adds++;return [{itemId:id,name:slot.name,success:true}]},
   read:async()=>[{id,name:slot.name,filePath,width:10,height:20,ext:'jpg'}],
   exists:(path,record)=>{try{return !!verifyEaglePhysicalFile({id:record?.itemId,name:record?.name,filePath:path})}catch{return false}},
   delays:[0],resolveReused:async({unverified})=>{reuseCalls+=unverified.length;return {resolved:[],unresolved:[]}}
 });
 assert.equal(adds,1);assert.equal(reuseCalls,0);assert.equal(result.records[0].verified,true);
 assert.equal(result.groups[0].status,'verified');
});
