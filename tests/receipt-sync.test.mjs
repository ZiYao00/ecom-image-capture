import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,mkdtempSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {reconcileProduct,expectedFromReceipt} from '../scripts/receipt-sync.mjs';
import {readRegistry} from '../scripts/capture-store.mjs';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const fixtureRoot=join(project,'data','.closeout-tests');
mkdirSync(fixtureRoot,{recursive:true});
const id='123456789012';
function scenario(opts={}){
 const root=mkdtempSync(join(fixtureRoot,'sync-'));
 const output=join(root,'images',id);
 const source=join(root,'eagle-local');
 const runDir=join(root,'data','runs','stable-'+id);
 mkdirSync(join(root,'data'),{recursive:true});
 mkdirSync(runDir,{recursive:true});
 mkdirSync(source,{recursive:true});
 mkdirSync(join(output,'main'),{recursive:true});
 mkdirSync(join(output,'detail'),{recursive:true});
 const images=[
  {category:'main',order:1,name:'Tmall-'+id+'-main-001',itemId:'E-1',verified:true,filePath:join(source,'1.jpg'),ext:'jpg'},
  {category:'detail',order:1,name:'Tmall-'+id+'-detail-001',itemId:'E-2',verified:true,filePath:join(source,'2.jpg'),ext:'jpg'}
 ];
 for(const [i,img] of images.entries()){
  const b=Buffer.from('real-image-fixture-'+(i+1));
  writeFileSync(img.filePath,b);
  writeFileSync(join(output,img.category,'01.jpg'),opts.mismatch&&i===1?
   Buffer.from('invalid-image-data'+(i+1)):b);
 }
 if(opts.missing){
  // Simulate an absent copy by making its output directory path unresolvable.
  images[1].ext='png';
 }
 const receipt={productId:id,skuId:'4567891011121',phase:opts.incomplete?'incomplete':'success',
  eagle:opts.unverified?'uncertain_no_retry':'verified',selected:{main:1,detail:1},
  copied:2,totalMs:17000,images,destination:output,errors:[]};
 if(!opts.noReceipt)writeFileSync(join(runDir,'receipt.json'),JSON.stringify(receipt,null,2));
 const url='https://detail.tmall.com/item.htm?id='+id+'&skuId=4567891011121';
 const registry={schemaVersion:1,products:{[id]:{
  productId:id,skuId:receipt.skuId,url,status:opts.initialStatus||'started',
  mainCount:0,detailCount:0,verifiedCount:0,copiedCount:0,
  durationMs:null,outputDir:opts.conflict?join(root,'wrong-folder'):output
 }}};
 writeFileSync(join(root,'data','captures.json'),JSON.stringify(registry,null,2));
 return {root,receipt,output};
}
test('read-only reconciliation detects a successful receipt but stale registry',async()=>{
 const {root}=scenario();
 const before=readFileSync(join(root,'data','captures.json'));
 const result=await reconcileProduct(root,id);
 assert.equal(result.status,'out_of_sync');
 assert.equal(result.changed,false);
 assert.ok(result.differences.some(d=>d.field==='status'));
 assert.equal(result.filesChecked,2);
 assert.ok(readFileSync(join(root,'data','captures.json')).equals(before));
});
test('interrupted second write can be repaired from verified receipt only, without reimporting',async()=>{
 const {root}=scenario();
 const result=await reconcileProduct(root,id,{apply:true});
 assert.equal(result.status,'repaired');
 assert.equal(result.sha256Checked,2);
 const indexed=readRegistry(root).products[id];
 assert.equal(indexed.status,'success');
 assert.equal(indexed.copiedCount,2);
 assert.equal(indexed.mainCount,1);
 assert.equal(indexed.detailCount,1);
 assert.equal((await reconcileProduct(root,id,{apply:true})).status,'consistent');
});
test('missing local image blocks repair; original registry remains unchanged',async()=>{
 const {root}=scenario({missing:true});
 await assert.rejects(reconcileProduct(root,id,{apply:true}),/Missing source\/copied image/);
 assert.equal(readRegistry(root).products[id].status,'started');
});
test('wrong same-size image content cannot be repaired',async()=>{
 const {root}=scenario({mismatch:true});
 // Ensure the wrong data has equal length so size checks alone would not be enough.
 const item=join(root,'images',id,'detail','01.jpg');
 const len=readFileSync(join(root,'eagle-local','2.jpg')).length;
 writeFileSync(item,Buffer.alloc(len,120));
 await assert.rejects(reconcileProduct(root,id,{apply:true}),/SHA-256 mismatch/);
 assert.equal(readRegistry(root).products[id].status,'started');
});
test('uncertain Eagle status and incomplete receipt do not repair registry',async()=>{
 const uncertain=scenario({unverified:true});
 await assert.rejects(reconcileProduct(uncertain.root,id,{apply:true}),/incomplete Eagle verification/);
 assert.equal(readRegistry(uncertain.root).products[id].status,'started');
 const incomplete=scenario({incomplete:true});
 const r=await reconcileProduct(incomplete.root,id,{apply:true});
 assert.equal(r.status,'incomplete');
 assert.equal(readRegistry(incomplete.root).products[id].status,'started');
});
test('conflicting destinations cannot be silently overwritten',async()=>{
 const {root}=scenario({conflict:true});
 assert.throws(()=>expectedFromReceipt(root,id),/destination conflicts/);
 await assert.rejects(reconcileProduct(root,id,{apply:true}),/destination conflicts/);
 assert.equal(readRegistry(root).products[id].status,'started');
});
test('a successful index with a failed or missing receipt is reported as conflict',async()=>{
 const incomplete=scenario({incomplete:true,initialStatus:'success'});
 const first=await reconcileProduct(incomplete.root,id);
 assert.equal(first.status,'conflict');
 const missing=scenario({noReceipt:true,initialStatus:'success'});
 const second=await reconcileProduct(missing.root,id);
 assert.equal(second.status,'conflict');
 assert.equal(second.changed,false);
});
test('legacy R01 is explicitly preserved without touching its receipt',async()=>{
 const {root}=scenario();
 const r=await reconcileProduct(root,'910333188743',{apply:true});
 assert.equal(r.status,'legacy');
 assert.equal(r.changed,false);
});
