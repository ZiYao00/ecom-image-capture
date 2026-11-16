import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {canonicalProductUrl,readRegistry,updateProduct,acquireProductLock,captureSummary} from '../scripts/capture-store.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),tmpRoot=join(root,'data','.capture-store-tests');
mkdirSync(tmpRoot,{recursive:true});
const prepare=()=>{
 const dir=mkdtempSync(join(tmpRoot,'test-'));mkdirSync(join(dir,'data'));
 writeFileSync(join(dir,'data','captures.json'),JSON.stringify({schemaVersion:1,products:{}}));
 return dir;
};
const clean=dir=>rmSync(dir,{recursive:true,force:true});
test('canonical URL keeps only product ID and SKU, not tracking or file provenance',()=>{
 const u=canonicalProductUrl('https://detail.tmall.com/item.htm?ali_refid=unused&skuId=4556&id=123456789012&spm=some');
 assert.deepEqual(u,{productId:'123456789012',skuId:'4556',url:'https://detail.tmall.com/item.htm?id=123456789012&skuId=4556'});
 assert.throws(()=>canonicalProductUrl('https://evil.com/item.htm?id=123456789012'));
});
test('a product record contains its final destination and derived counts',()=>{
 const r=captureSummary({productId:'123456789012',skuId:'4556',phase:'success',eagle:'verified',
 selected:{main:5,detail:2},images:[{verified:true},{verified:true}],copied:7,totalMs:25000},
 {outputDir:join(root,'somewhere')});
 assert.equal(r.outputDir,resolve(root,'somewhere'));
 assert.equal(r.mainCount,5);assert.equal(r.detailCount,2);
 assert.equal(r.status,'success');
 assert.ok(!('sourcePath' in r||'sourceFile' in r));
});
test('serializes concurrent writers and preserves previous records',async()=>{
 const dir=prepare();
 try{
  const ids=Array.from({length:14},(_,i)=>String(120000000000+i));
  await Promise.all(ids.map(async id=>{
   const url=canonicalProductUrl('https://detail.tmall.com/item.htm?id='+id);
   return updateProduct(dir,{...url,status:'pending',mainCount:0,detailCount:0,
    verifiedCount:0,copiedCount:0,durationMs:null,outputDir:null});
  }));
  const all=readRegistry(dir).products;
  assert.equal(Object.keys(all).length,14);
  assert.ok(ids.every(id=>all[id].productId===id));
 }finally{clean(dir)}
});
test('independent Node processes cannot lose JSON updates',async()=>{
 const dir=prepare();
 try{
  const worker=resolve(root,'tests','capture-store-worker.mjs');
  const run=id=>new Promise((yes,no)=>{
   const p=spawn(process.execPath,[worker,dir,id],{stdio:['ignore','pipe','pipe'],windowsHide:true});
   let err='';
   p.stderr.on('data',v=>err+=v);
   p.once('error',no);
   p.once('exit',code=>code===0?yes():no(Error(id+': '+err.slice(0,300))));
  });
  const ids=Array.from({length:7},(_,i)=>String(230000000000+i));
  await Promise.all(ids.map(run));
  assert.equal(Object.keys(readRegistry(dir).products).length,7);
 }finally{clean(dir)}
});
test('same-product lock prevents duplicate task while different product lock remains available',()=>{
 const dir=prepare();
 try{
  const first=acquireProductLock(dir,'123456789012');
  assert.throws(()=>acquireProductLock(dir,'123456789012'),/already being handled|lock is active/);
  const second=acquireProductLock(dir,'123456789013');
  second();first();
  const third=acquireProductLock(dir,'123456789012');third();
 }finally{clean(dir)}
});
test('copy verification can explicitly mark an incomplete result without losing the product',async()=>{
 const dir=prepare();
 try{
  const link=canonicalProductUrl('https://detail.tmall.com/item.htm?id=123456789012&skuId=4556');
  await updateProduct(dir,{...link,status:'success',mainCount:5,detailCount:0,
   verifiedCount:5,copiedCount:5,durationMs:1000,outputDir:join(dir,'exports','123456789012')});
  await updateProduct(dir,{productId:link.productId,status:'incomplete',copiedCount:3},
    {allowSuccessDowngrade:true});
  const item=readRegistry(dir).products[link.productId];
  assert.equal(item.status,'incomplete');assert.equal(item.copiedCount,3);
  assert.equal(item.outputDir,resolve(dir,'exports','123456789012'));
 }finally{clean(dir)}
});
test('successful product cannot be downgraded and URL/SKU are preserved',async()=>{
 const dir=prepare();
 try{
  const first=canonicalProductUrl('https://detail.tmall.com/item.htm?id=123456789012&skuId=4556');
  await updateProduct(dir,{...first,status:'success',mainCount:5,detailCount:3,
   verifiedCount:8,copiedCount:8,durationMs:5000,outputDir:join(dir,'output','123456789012')});
  await assert.rejects(updateProduct(dir,{productId:first.productId,status:'started'}),/Cannot downgrade/);
  await updateProduct(dir,{productId:first.productId,status:'success',skuId:null,outputDir:null});
  const product=readRegistry(dir).products[first.productId];
  assert.equal(product.skuId,'4556');
  assert.equal(product.outputDir,resolve(dir,'output','123456789012'));
  assert.equal(product.url,first.url);
 }finally{clean(dir)}
});
