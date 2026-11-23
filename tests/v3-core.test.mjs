import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {listWebApiItems,makeIndexRows,openFingerprintDatabase,chooseExactMatch,visibleEagleItemCount,syncV3StitchPartsToIndex} from '../scripts/v3-fingerprint.mjs';
import {BROWSER_IMAGE_HEADERS,fetchOriginalBytes,validateOriginalRepresentation,saveCacheFile,prefetchOriginalRepresentation} from '../scripts/v3-prefetch.mjs';
import {nextState,maySubmitSlot,needsOnlyReadback,createJob,createStoredJob,recordJobEvent,loadJob,acquireLibraryLock} from '../scripts/v3-job-state.mjs';
import {resolveV3ExactMatch,eagleV2GetById,eagleV2AddFromPath} from '../scripts/v3-eagle-import.mjs';

const sqliteTest = Number(process.versions.node.split('.')[0]) >= 24 ? test : test.skip;
const id='ABCDEF12345678';
const fakeRoot=()=>mkdtempSync(join(tmpdir(),'ecom-v3-'));
const sha=data=>createHash('sha256').update(data).digest('hex');
const jpg=Buffer.from([255,216,255,224,1,2,3,4,5,6,7,8,9,10,11,12]);
const gif=Buffer.from('GIF89a'+('x'.repeat(20)),'ascii');
const url='https://img.alicdn.com/imgextra/a/test.jpg';
function fixture(root,{itemId=id,content=jpg,folder='FOLDER'}={}){
  const dir=join(root,'images',itemId+'.info');
  mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'asset.jpg'),content);
  writeFileSync(join(dir,'metadata.json'),JSON.stringify({id:itemId,name:'asset',ext:'jpg',
    width:20,height:30,folders:[folder],isDeleted:false}));
  return {id:itemId,name:'asset',ext:'jpg',width:20,height:30,folders:[folder],isDeleted:false};
}
test('V3 browser-like Accept header avoids blind format conversion',()=>{
  assert.match(BROWSER_IMAGE_HEADERS.Accept,/image\/webp/);
  assert.match(BROWSER_IMAGE_HEADERS['User-Agent'],/Chrome/);
  assert.deepEqual(validateOriginalRepresentation(url,'jpg'),{status:'matched',sourceExt:'jpg'});
  assert.equal(validateOriginalRepresentation(url,'webp').status,'representation_changed');
});
test('V3 fetch never follows unsafe URLs and hashes the exact response bytes',async()=>{
  const f=async()=>new Response(jpg,{status:200,headers:{'content-type':'image/jpeg'}});
  const r=await fetchOriginalBytes(url,{fetchFn:f});
  assert.equal(r.sha256,sha(jpg));assert.equal(r.ext,'jpg');assert.deepEqual(r.bytes,jpg);
  await assert.rejects(()=>fetchOriginalBytes('http://evil.test/x.jpg',{fetchFn:f}),/allowed HTTPS/);
});
test('V3 safely renegotiates WebP to original JPEG without transcode or Eagle write',async()=>{
  const webp=Buffer.concat([Buffer.from('RIFF'),Buffer.from([8,0,0,0]),Buffer.from('WEBP'),Buffer.alloc(12)]);
  let calls=0;
  const result=await prefetchOriginalRepresentation(url,{fetchFn:async(_url,args)=>{
    calls++;const accept=args.headers.Accept;
    const bytes=accept.includes('image/avif')?webp:jpg;
    return new Response(bytes,{status:200,headers:{'content-type':bytes===webp?'image/webp':'image/jpeg'}});
  }});
  assert.equal(result.ext,'jpg');
  assert.equal(result.fetchAttempt,2);
  assert.equal(calls,2);
  assert.equal(result.sha256,sha(jpg));
});
test('V3 records consistent server-side PNG URL to JPEG response without transcoding',async()=>{
  let calls=0;
  const r=await prefetchOriginalRepresentation('https://img.alicdn.com/imgextra/i2/product.png',{
    fetchFn:async()=>{
      calls++;
      return new Response(jpg,{status:200,headers:{'content-type':'image/jpeg'}});
    }
  });
  assert.equal(r.ext,'jpg');
  assert.equal(r.sha256,sha(jpg));
  assert.equal(r.representation.status,'server_encoded_differently');
  assert.equal(r.representation.sourceExt,'png');
  assert.equal(r.representation.receivedExt,'jpg');
  assert.equal(calls,4);
});
test('V3 prefetch cache writes once, verifies duplicates and refuses unsafe identities',()=>{
  const root=fakeRoot(),slot={category:'main',order:1},result={bytes:jpg,sha256:sha(jpg),size:jpg.length,ext:'jpg'};
  const p=saveCacheFile(root,'1005836374256',slot,result);
  assert.ok(existsSync(p));assert.equal(saveCacheFile(root,'1005836374256',slot,result),p);
  assert.throws(()=>saveCacheFile(root,'1005836374256',{category:'main',order:-1},result),/identity/);
});
test('V3 exact-byte candidate choice prefers an already-associated physical Eagle item',()=>{
  const digest=sha(jpg);
  const selected=chooseExactMatch([
    {id:'A1111111',verified:true,sha256:digest,folders:[]},
    {id:'B2222222',verified:true,sha256:digest,folders:['D']}
  ],'D');
  assert.equal(selected.id,'B2222222');
  assert.equal(chooseExactMatch([{id:'C',verified:false,sha256:digest}], 'D'),null);
});
test('V3 Eagle enumeration is paginated and rejects overlapping item IDs',async()=>{
  let calls=0;
  const mocked=async()=>{
    calls++;const rows=calls===1?[{id:'A'},{id:'B'}]:[{id:'C'}];
    return {ok:true,json:async()=>({status:'success',data:{data:rows,total:3}})};
  };
  const listed=await listWebApiItems({fetchFn:mocked,pageSize:2});
  assert.equal(listed.items.length,3);assert.equal(calls,2);
  await assert.rejects(()=>listWebApiItems({fetchFn:async()=>({ok:true,
    json:async()=>({status:'success',data:{data:[{id:'A'},{id:'A'}],total:2}})})}),/Duplicate\/invalid/);
});
test('V3 uses /item/get visible total, not countAll which includes excluded records',async()=>{
  const requested=[];
  const n=await visibleEagleItemCount({fetchFn:async url=>{
    requested.push(url);
    return {ok:true,json:async()=>({status:'success',data:{data:[{id:'ABC'}],total:1409}})};
  }});
  assert.equal(n,1409);
  assert.match(requested[0],/\/item\/get/);
  assert.doesNotMatch(requested[0],/countAll/);
});
sqliteTest('V3 SQLite indexes verified physical files and supports active-generation lookup',async()=>{
  const root=fakeRoot(),item=fixture(root);
  const records=await makeIndexRows(root,[item,{id:'X',ext:'mp4'}]);
  assert.equal(records.invalid.length,0);assert.equal(records.rows.length,1);
  assert.equal(records.skipped,1);
  const db=await openFingerprintDatabase(':memory:',{libraryPath:root});
  const digest=sha(jpg);
  try{
    assert.equal(db.lookup(digest).length,0);
    db.writeGeneration(records.rows);
    assert.equal(db.lookup(digest)[0].id,id);
    assert.equal(db.lookup('f'.repeat(64)).length,0);
    db.upsertVerified({...records.rows[0],id:'ALTID123456',folders:['OTHER']});
    assert.equal(db.lookup(digest).length,2);
  }finally{db.close()}
});
sqliteTest('V3 indexes newly stitched output exactly once and adjusts visible count',async()=>{
  const root=fakeRoot(), item=fixture(root),indexPath=join(root,'v3-index.sqlite');
  const db=await openFingerprintDatabase(indexPath,{libraryPath:root});
  db.writeGeneration([],{libraryItemTotal:0});db.close();
  const parts=[{id:item.id,sha256:sha(jpg),width:item.width,height:item.height}];
  const result=await syncV3StitchPartsToIndex({
    indexPath,libraryPath:root,parts,getById:async id=>id===item.id?item:null,
    getLiveCount:async()=>1});
  assert.equal(result.status,'synced');
  assert.equal(result.added,1);
  const check=await openFingerprintDatabase(indexPath,{libraryPath:root});
  try{assert.equal(check.lookup(sha(jpg)).length,1);assert.equal(check.info().libraryItemTotal,'1')}
  finally{check.close()}
});
test('V3 journal refuses unsafe transitions and tracks uncertain submit attempts',()=>{
  const root=fakeRoot(),job=createJob({productId:'1005836374256',
    url:'https://detail.tmall.com/item.htm?id=1005836374256',libraryPath:'D:/test',
    slots:[{category:'main',order:1,name:'test',url}]});
  createStoredJob(root,job);
  assert.throws(()=>nextState('planned','verified'),/Unsafe/);
  recordJobEvent(root,job,{slotKey:'main:1',state:'prefetched',event:'download',metadata:{sha256:sha(jpg)}});
  assert.ok(maySubmitSlot(job.slots[0]));
  recordJobEvent(root,job,{slotKey:'main:1',state:'import_intent',event:'submit'});
  assert.equal(maySubmitSlot(job.slots[0]),false);
  assert.equal(needsOnlyReadback(job.slots[0]),true);
  assert.equal(loadJob(root,job.productId).slots[0].state,'import_intent');
  assert.throws(()=>nextState('import_intent','prefetched'),/Unsafe/);
});
test('V3 library lock blocks concurrent writers and archives released locks',()=>{
  const root=fakeRoot(),close=acquireLibraryLock(root,'D:/eagle/test');
  assert.throws(()=>acquireLibraryLock(root,'D:/eagle/test'),/already exists/);
  close();
  const next=acquireLibraryLock(root,'D:/eagle/test');next();
});
test('V3 resolved identity requires Web API and physical byte verification',async()=>{
  const root=fakeRoot(),item=fixture(root);
  const found=await resolveV3ExactMatch({
    index:{lookup:()=>[{id,sha256:sha(jpg)}]},sha256:sha(jpg),folderId:'FOLDER',
    getById:async requested=>requested===id?item:null,libraryPath:root
  });
  assert.equal(found.id,id);assert.equal(found.verified,true);
  await assert.rejects(()=>resolveV3ExactMatch({
    index:{lookup:()=>[{id,sha256:sha(jpg)}]},sha256:sha(jpg),folderId:'FOLDER',
    getById:async()=>({...item,width:21}),libraryPath:root
  }),/never reimport same bytes/);
});
test('V3 Web API add is single attempt, and requires a real returned ID',async()=>{
  const root=fakeRoot(),path=join(root,'source.jpg');writeFileSync(path,jpg);
  let calls=0;
  const good=async()=>{calls++;return {ok:true,json:async()=>({status:'success',data:{id:'ITEM123456'}})}};
  assert.equal(await eagleV2AddFromPath({path,name:'slot',folder:'FOLDER123',website:'https://detail.tmall.com/item.htm?id=1005836374256'},{fetchFn:good}),'ITEM123456');
  assert.equal(calls,1);
  await assert.rejects(()=>eagleV2AddFromPath({path,name:'slot',folder:'FOLDER123'},{fetchFn:async()=>({ok:true,json:async()=>({status:'success',data:{}})})}),/without valid item ID/);
});
test('V3 Web API get requires exact returned item ID',async()=>{
  const out=await eagleV2GetById(id,{fetchFn:async()=>({ok:true,json:async()=>({status:'success',data:{data:[{id:'OTHER'}],total:1}})})});
  assert.equal(out,null);
});
