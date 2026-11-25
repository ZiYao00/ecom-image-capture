import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {buildLegacyRecoveryPlan,inspectPartialJournal} from '../scripts/v3-recovery-core.mjs';
import {processV3ImportedImages} from '../scripts/v3-eagle-import.mjs';
import {openFingerprintDatabase,makeIndexRows,assertFingerprintInventory,refreshFingerprintIndex} from '../scripts/v3-fingerprint.mjs';
import {loadJob} from '../scripts/v3-job-state.mjs';
const tSql=Number(process.versions.node.split('.')[0])>=24?test:test.skip;
const productId='1023627416066',url='https://detail.tmall.com/item.htm?id='+productId;
const main='MAINFOLDER123',detail='DETAILFOLDER123';
const image=(n)=>{const bytes=Buffer.from([255,216,255,224,1,2,3,4,5,6,7,8,9,10,11,n]);return {bytes,ext:'jpg',sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,mime:'image/jpeg'}};
const slots=[{category:'main',order:1},{category:'detail',order:1},{category:'detail',order:2}].map((x,i)=>({...x,name:'Tmall-'+productId+'-'+x.category+'-'+String(x.order).padStart(3,'0'),url:'https://img.alicdn.com/imgextra/'+(i+1)+'.jpg'}));
const assets=slots.map((_,i)=>image(i+1));
function legacy(){
 const images=slots.map(x=>({...x}));
 Object.assign(images[0],{verified:true,itemId:'OLDMAIN12345',sha256:assets[0].sha256});
 Object.assign(images[2],{verified:false,submissionStatus:'not_submitted_due_to_prior_uncertain_batch'});
 const r={productId,phase:'incomplete',eagle:'partially_verified',selected:{main:1,detail:2},folderIds:{main,detail},images,
 eagleBatches:[{index:1,start:0,count:2,names:images.slice(0,2).map(x=>x.name),ids:['OLDMAIN12345','GHOSTITEM123'],status:'partial',halted:true,unsubmitted:1}],eagleReturnedItemIds:['OLDMAIN12345','GHOSTITEM123']};
 return {r,plan:buildLegacyRecoveryPlan(r,Buffer.from(JSON.stringify(r)))};
}
function setup(){
 const root=mkdtempSync(join(tmpdir(),'ecom-v3-partial-')),libraryPath=join(root,'library');
 mkdirSync(libraryPath,{recursive:true});
 const records=new Map(),indexPath=join(root,'data','fingerprints','v3-eagle.sqlite');
 function put(id,name,asset,folders){
   const dir=join(libraryPath,'images',id+'.info');mkdirSync(dir,{recursive:true});
   writeFileSync(join(dir,name+'.jpg'),asset.bytes);
   const row={id,name,ext:'jpg',width:20,height:30,folders,isDeleted:false};
   writeFileSync(join(dir,'metadata.json'),JSON.stringify(row));records.set(id,row);return row;
 }
 async function rebuild(){
   const rows=await makeIndexRows(libraryPath,[...records.values()]);
   assert.equal(rows.invalid.length,0);
   const db=await openFingerprintDatabase(indexPath,{libraryPath});
   db.writeGeneration(rows.rows,{libraryItemTotal:records.size});db.close();
 }
 const defaults={root,productId,url,libraryPath,folderIds:{main,detail},indexPath,
   getById:async id=>records.get(id)||null,checkLibrary:async()=>records.size,
   fetchImage:async u=>assets[slots.findIndex(x=>x.url===u)],
   linkFolders:async()=>{throw Error('unexpected link')}};
 return {root,libraryPath,records,indexPath,put,rebuild,defaults};
}
test('legacy partial plan requires positive proof of every unsubmitted tail slot',()=>{
 const {r,plan}=legacy();
 assert.deepEqual(plan.slots.map(x=>x.kind),['historical_verified','historical_uncertain','unsubmitted']);
 delete r.images[2].submissionStatus;
 assert.throws(()=>buildLegacyRecoveryPlan(r,Buffer.from(JSON.stringify(r))),/zero-submission proof/);
});
tSql('legacy recovery reads both submitted positions and imports only the proven unsubmitted tail',async()=>{
 const f=setup(),{r,plan}=legacy();
 f.put('OLDMAIN12345',slots[0].name,assets[0],[main]);
 f.put('REUSEDDETAIL123','shared',assets[1],[detail]);
 await f.rebuild();
 let imports=0;
 const args={...f.defaults,images:r.images,legacyPlan:plan,importLocal:async x=>{
   imports++;assert.equal(x.name,slots[2].name);return f.put('NEWDETAIL123',x.name,assets[2],[detail]).id;
 }};
 const check=await processV3ImportedImages({...args,checkOnly:true});
 assert.equal(check.protected,2);assert.equal(check.pending,1);assert.equal(imports,0);
 assert.equal(loadJob(f.root,productId),null);
 const result=await processV3ImportedImages(args);
 assert.equal(result.status,'verified');assert.equal(imports,1);
 assert.deepEqual(result.images.map(x=>x.itemId),['OLDMAIN12345','REUSEDDETAIL123','NEWDETAIL123']);
 const again=await processV3ImportedImages({...args,resumePartial:true,checkOnly:true});
 assert.equal(again.protected,3);assert.equal(again.pending,0);
});
tSql('unresolved or ambiguous old submissions stop before any new Eagle writes',async()=>{
 const f=setup(),{r,plan}=legacy();
 f.put('OLDMAIN12345',slots[0].name,assets[0],[main]);
 f.put('DUPLICATE1234','a',assets[1],[detail]);
 f.put('DUPLICATE5678','b',assets[1],[detail]);
 await f.rebuild();let imports=0;
 const args={...f.defaults,images:r.images,legacyPlan:plan,importLocal:async()=>{imports++;throw Error('unexpected import')}};
 await assert.rejects(()=>processV3ImportedImages({...args,checkOnly:true}),/one exact existing target-folder match/);
 await assert.rejects(()=>processV3ImportedImages(args),/Protected slot not re-submitted/);
 assert.equal(imports,0);
});
tSql('partial V3 recovers a lost import acknowledgment by readback and never replays it',async()=>{
 const f=setup();await f.rebuild();let imports=0;
 const args={...f.defaults,images:slots.slice(0,2),importLocal:async x=>{
   imports++;
   if(x.name===slots[0].name){f.put('LOSTACKITEM123',x.name,assets[0],[main]);throw Error('lost response')}
   return f.put('LATERITEM123',x.name,assets[1],[detail]).id;
 }};
 await assert.rejects(()=>processV3ImportedImages(args),/lost response/);assert.equal(imports,1);
 await f.rebuild();
 const check=await processV3ImportedImages({...args,resumePartial:true,checkOnly:true});
 assert.equal(check.protected,1);assert.equal(check.pending,1);
 const result=await processV3ImportedImages({...args,resumePartial:true});
 assert.equal(result.status,'verified');assert.equal(imports,2);
 assert.deepEqual(result.images.map(x=>x.itemId),['LOSTACKITEM123','LATERITEM123']);
});
tSql('unresolved V3 write intent remains read-only and later slots stay untouched',async()=>{
 const f=setup();await f.rebuild();let imports=0;
 const args={...f.defaults,images:slots.slice(0,2),importLocal:async()=>{imports++;throw Error('unknown outcome')}};
 await assert.rejects(()=>processV3ImportedImages(args),/unknown outcome/);
 await assert.rejects(()=>processV3ImportedImages({...args,resumePartial:true}),/Protected slot not re-submitted/);
 assert.equal(imports,1);
});
tSql('same-count Eagle replacement is detected before write phase',async()=>{
 const f=setup();
 const old=f.put('OLDMAIN12345',slots[0].name,assets[0],[main]);await f.rebuild();
 const db=await openFingerprintDatabase(f.indexPath,{libraryPath:f.libraryPath});
 try{
   await assertFingerprintInventory(db,f.libraryPath,{listItems:async()=>({total:1,items:[old]})});
   const replacement=f.put('REPLACEMENT123','new',assets[1],[main]);
   await assert.rejects(()=>assertFingerprintInventory(db,f.libraryPath,{listItems:async()=>({total:1,items:[replacement]})}),/identity or physical metadata changed/);
 }finally{db.close()}
});
tSql('ledger and snapshot disagreement blocks partial recovery',async()=>{
 const f=setup();await f.rebuild();
 const args={...f.defaults,images:slots.slice(0,2),importLocal:async()=>{throw Error('unknown outcome')}};
 await assert.rejects(()=>processV3ImportedImages(args),/unknown outcome/);
 const job=loadJob(f.root,productId);job.events++;
 assert.throws(()=>inspectPartialJournal(f.root,job,args.images,f.libraryPath,url),/count mismatch/);
});

tSql('prewrite external additions are incrementally reconciled once before new recovery writes',async()=>{
 const f=setup(),{r,plan}=legacy();
 f.put('OLDMAIN12345',slots[0].name,assets[0],[main]);
 f.put('REUSEDDETAIL123','shared',assets[1],[detail]);await f.rebuild();
 f.put('EXTERNALIMG123','unrelated',image(17),['OTHER']);
 let refreshes=0,imports=0;
 const listItems=async()=>({total:f.records.size,items:[...f.records.values()]});
 const result=await processV3ImportedImages({...f.defaults,images:r.images,legacyPlan:plan,
  checkInventory:(db,path)=>assertFingerprintInventory(db,path,{listItems}),
  refreshInventory:async(db,path)=>{refreshes++;return refreshFingerprintIndex(db,path,{listItems});},
  importLocal:async x=>{imports++;assert.equal(x.name,slots[2].name);return f.put('NEWDETAIL123',x.name,assets[2],[detail]).id;}
 });
 assert.equal(result.status,'verified');assert.equal(refreshes,1);assert.equal(imports,1);
 assert.deepEqual(result.images.map(x=>x.itemId),['OLDMAIN12345','REUSEDDETAIL123','NEWDETAIL123']);
});
tSql('external drift after an import stops before the next slot; no automatic write-stage refresh',async()=>{
 const f=setup();await f.rebuild();let imports=0,refreshes=0;
 const listItems=async()=>({total:f.records.size,items:[...f.records.values()]});
 await assert.rejects(()=>processV3ImportedImages({...f.defaults,images:slots,
  checkInventory:(db,path)=>assertFingerprintInventory(db,path,{listItems}),
  refreshInventory:async(db,path)=>{refreshes++;return refreshFingerprintIndex(db,path,{listItems});},
  importLocal:async x=>{
   imports++;const row=f.put('NEWMAIN12345',x.name,assets[0],[main]);
   f.put('EXTERNALIMG123','unrelated',image(17),['OTHER']);return row.id;
  }
 }),/library changed since fingerprint indexing/);
 const job=loadJob(f.root,productId);
 assert.equal(imports,1);assert.equal(refreshes,0);assert.equal(job.slots[0].state,'verified');
 assert.equal(job.slots[1].submitIntentRecorded,false);assert.equal(job.slots[2].submitIntentRecorded,false);
});
