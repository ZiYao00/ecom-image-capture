import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{createHash}from'node:crypto';
import{openFingerprintDatabase,makeIndexRows}from'../scripts/v3-fingerprint.mjs';
import{processV3ImportedImages}from'../scripts/v3-eagle-import.mjs';
import{loadJob,createJob,createStoredJob,recordJobEvent}from'../scripts/v3-job-state.mjs';
import{saveCacheFile}from'../scripts/v3-prefetch.mjs';
import{v3WebReadItems}from'../scripts/v3-web-readback.mjs';

const png=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082','hex');
const digest=createHash('sha256').update(png).digest('hex');
const root=()=>mkdtempSync(join(tmpdir(),'ecom-v3-e2e-'));
const id='1005836374256',url='https://detail.tmall.com/item.htm?id='+id;
const slot={category:'detail',order:1,name:'Tmall-'+id+'-detail-001',
  url:'https://img.alicdn.com/imgextra/i1/normal.png'};
const imageResult={bytes:png,ext:'png',sha256:digest,size:png.length,mime:'image/png'};
const folderId='DETAILFOLDER123';
function eagleRecord(lib,assetId,folders=[folderId]){
  const dir=join(lib,'images',assetId+'.info');
  mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'test.png'),png);
  writeFileSync(join(dir,'metadata.json'),JSON.stringify({id:assetId,name:'test',ext:'png',
    width:1,height:1,isDeleted:false,folders}));
  return {id:assetId,name:'test',ext:'png',width:1,height:1,isDeleted:false,folders};
}
async function openIndex(project,library,rows,libraryItemTotal) {
  const path=join(project,'data','fingerprints','v3-eagle.sqlite');
  mkdirSync(join(project,'data','fingerprints'),{recursive:true});
  const db=await openFingerprintDatabase(path,{libraryPath:library});
  db.writeGeneration(rows,{libraryItemTotal});db.close();
  return path;
}
test('V3 full mocked capture reuses the same verified Eagle bytes without item_add',async()=>{
  const project=root(),library=join(project,'eagle');
  const row=eagleRecord(library,'ORIGINAL123',[]);
  const evidence=await makeIndexRows(library,[row]);
  const indexPath=await openIndex(project,library,evidence.rows,1);
  let imported=0,links=0,member=row;
  const result=await processV3ImportedImages({root:project,productId:id,url,images:[slot],
    libraryPath:library,folderIds:{main:'MAINFOLDER123',detail:folderId},indexPath,
    fetchImage:async()=>imageResult,checkLibrary:async()=>1,
    getById:async requested=>requested===member.id?member:null,
    importLocal:async()=>{imported++;throw Error('MUST_NOT_IMPORT')},
    linkFolders:async()=>{links++;member={...member,folders:[folderId]}}
  });
  assert.equal(result.status,'verified');
  assert.equal(result.images.length,1);
  assert.equal(result.images[0].itemId,'ORIGINAL123');
  assert.equal(imported,0);assert.equal(links,1);
  assert.equal(loadJob(project,id).slots[0].state,'verified');
});
test('V3 full mocked capture creates one new Eagle item, verifies it, updates index',async()=>{
  const project=root(),library=join(project,'eagle');mkdirSync(library,{recursive:true});
  const indexPath=await openIndex(project,library,[],0);
  let imported=0,items=0,record=null;
  const result=await processV3ImportedImages({root:project,productId:id,url,images:[slot],
    libraryPath:library,folderIds:{main:'MAINFOLDER123',detail:folderId},indexPath,
    fetchImage:async()=>imageResult,checkLibrary:async()=>items,
    getById:async requested=>record?.id===requested?record:null,
    linkFolders:async()=>{throw Error('MUST_NOT_LINK')},
    importLocal:async()=>{imported++;record=eagleRecord(library,'NEWITEM12345');items++;return record.id}
  });
  assert.equal(result.status,'verified');assert.equal(imported,1);
  assert.equal(result.images[0].resolution,'imported');
  const db=await openFingerprintDatabase(indexPath,{libraryPath:library});
  try{assert.equal(db.lookup(digest)[0].id,'NEWITEM12345');assert.equal(Number(db.info().libraryItemTotal),1)}
  finally{db.close()}
});
test('V3 uncertain item_add stops after one attempt and forbids a second run',async()=>{
  const project=root(),library=join(project,'eagle');mkdirSync(library,{recursive:true});
  const indexPath=await openIndex(project,library,[],0);
  let attempted=0;
  const cfg={root:project,productId:id,url,images:[slot],
    libraryPath:library,folderIds:{main:'MAINFOLDER123',detail:folderId},indexPath,
    fetchImage:async()=>imageResult,checkLibrary:async()=>0,
    getById:async()=>null,linkFolders:async()=>{},
    importLocal:async()=>{attempted++;throw Error('Eagle request outcome unknown')}};
  await assert.rejects(()=>processV3ImportedImages(cfg),/journal/);
  assert.equal(attempted,1);
  assert.equal(loadJob(project,id).slots[0].state,'needs_read_only_review');
  await assert.rejects(()=>processV3ImportedImages(cfg),/EEXIST|already exists/);
  assert.equal(attempted,1);
});
test('V3 missing verified index generation leaves no durable job or Eagle import',async()=>{
  const project=root(),library=join(project,'eagle');mkdirSync(library,{recursive:true});
  const path=join(project,'data','fingerprints','empty.sqlite');
  const db=await openFingerprintDatabase(path,{libraryPath:library});db.close();
  let imports=0;
  await assert.rejects(()=>processV3ImportedImages({
    root:project,productId:id,url,images:[slot],libraryPath:library,
    folderIds:{main:'MAINFOLDER123',detail:folderId},indexPath:path,
    getById:async()=>null,checkLibrary:async()=>0,
    fetchImage:async()=>imageResult,linkFolders:async()=>{},
    importLocal:async()=>{imports++;throw Error('SHOULD_NOT_IMPORT')}
  }),/no verified generation/);
  assert.equal(imports,0);
  assert.equal(loadJob(project,id),null);
});
test('V3 stale hash candidate never causes an unintended new import',async()=>{
  const project=root(),library=join(project,'eagle');mkdirSync(library,{recursive:true});
  const path=await openIndex(project,library,[{id:'STALEITEM123',sha256:digest,size:png.length,
    ext:'png',name:'stale',width:1,height:1,mtime:0,folders:[]}],1);
  let imports=0;
  await assert.rejects(()=>processV3ImportedImages({
    root:project,productId:id,url,images:[slot],libraryPath:library,
    folderIds:{main:'MAINFOLDER123',detail:folderId},indexPath:path,
    getById:async()=>null,checkLibrary:async()=>1,
    fetchImage:async()=>imageResult,linkFolders:async()=>{},
    importLocal:async()=>{imports++;throw Error('SHOULD_NOT_IMPORT')}
  }),/never reimport same bytes/);
  assert.equal(imports,0);
  assert.equal(loadJob(project,id).slots[0].state,'needs_read_only_review');
});
test('V3 proven zero-write recovery can reuse verified cached bytes without new prefetch',async()=>{
  const project=root(),library=join(project,'eagle');mkdirSync(library,{recursive:true});
  const indexPath=await openIndex(project,library,[],0);
  const job=createJob({productId:id,url,libraryPath:library,slots:[slot]});
  createStoredJob(project,job);
  const cachePath=saveCacheFile(project,id,slot,imageResult);
  recordJobEvent(project,job,{slotKey:'detail:1',state:'prefetched',
    event:'original_bytes_verified',metadata:{sha256:digest,cachePath,bytes:png.length,ext:'png'}});
  recordJobEvent(project,job,{slotKey:'detail:1',state:'needs_read_only_review',
    event:'eagle_outcome_uncertain',metadata:{error:'Eagle library changed since fingerprint indexing; safely stop before any new item_add'}});
  let fetched=0,imported=0,record=null,items=0;
  const result=await processV3ImportedImages({root:project,productId:id,url,images:[slot],
    libraryPath:library,folderIds:{main:'MAINFOLDER123',detail:folderId},indexPath,
    resumeNoWrite:true,checkLibrary:async()=>items,
    getById:async requested=>requested===record?.id?record:null,
    linkFolders:async()=>{},fetchImage:async()=>{fetched++;throw Error('should use cache')},
    importLocal:async()=>{imported++;record=eagleRecord(library,'RESUMED12345');items++;return record.id}
  });
  assert.equal(result.status,'verified');
  assert.equal(imported,1);assert.equal(fetched,0);
  assert.equal(loadJob(project,id).slots[0].state,'verified');
});
test('V3 cannot resume a job whose durable ledger contains an import intent',async()=>{
  const project=root(),library=join(project,'eagle');mkdirSync(library,{recursive:true});
  const indexPath=await openIndex(project,library,[],0);
  const job=createJob({productId:id,url,libraryPath:library,slots:[slot]});createStoredJob(project,job);
  recordJobEvent(project,job,{slotKey:'detail:1',state:'prefetched',event:'original_bytes_verified',
    metadata:{sha256:digest,cachePath:saveCacheFile(project,id,slot,imageResult),bytes:png.length,ext:'png'}});
  recordJobEvent(project,job,{slotKey:'detail:1',state:'import_intent',event:'single_eagle_import_submitting'});
  let imported=0;
  await assert.rejects(()=>processV3ImportedImages({root:project,productId:id,url,images:[slot],
    libraryPath:library,folderIds:{main:'MAINFOLDER123',detail:folderId},indexPath,resumeNoWrite:true,
    getById:async()=>null,checkLibrary:async()=>0,linkFolders:async()=>{},
    importLocal:async()=>{imported++;throw Error('should never import')}}),/write intent exists/);
  assert.equal(imported,0);
});
test('V3 Web API readback recovers an item that Eagle MCP failed to list',async()=>{
  const project=root(),library=join(project,'library');
  const row=eagleRecord(library,'EXISTING123');
  let count=0;
  const result=await v3WebReadItems({libraryPath:library,query:{ids:[row.id]},
    fetchFn:async()=>{count++;return {ok:true,json:async()=>({status:'success',data:{data:[row],total:1}})}}});
  assert.equal(count,1);assert.equal(result.length,1);
  assert.equal(result[0].filePath?.endsWith('test.png'),true);
  assert.equal(existsSync(result[0].filePath),true);
});
