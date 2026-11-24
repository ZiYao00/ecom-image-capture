import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBatchUrls,classifyBatchProduct,shouldHaltBatchAfterAttempt} from '../scripts/batch-core.mjs';
const a='https://detail.tmall.com/item.htm?abbucket=11&id=644572484093&pisk=literal-tracking-token';
const b='https://detail.tmall.com/item.htm?abbucket=4&id=976328773394&skuId=5946756932483&xxc=taobaoSearch';
test('batch parser preserves complete original URLs and ordered item IDs',()=>{
 const items=parseBatchUrls('\uFEFF'+a+'\r\n# comment\r\n'+b+'\r\n');
 assert.equal(items.length,2);
 assert.equal(items[0].fullUrl,a);assert.equal(items[0].productId,'644572484093');
 assert.equal(items[1].fullUrl,b);assert.equal(items[1].skuId,'5946756932483');
 assert.equal(items[1].index,2);
});
test('batch accepts a JSON string-array while refusing duplicate IDs and invalid domains',()=>{
 assert.deepEqual(parseBatchUrls(JSON.stringify([b])).map(x=>x.productId),['976328773394']);
 assert.throws(()=>parseBatchUrls(a+'\n'+a),/Duplicate product/);
 assert.throws(()=>parseBatchUrls('https://evil.example/item.htm?id=644572484093'),/Invalid Tmall/);
 assert.throws(()=>parseBatchUrls(' '),/Empty batch/);
 assert.throws(()=>parseBatchUrls(Array.from({length:41},(_,i)=>
  'https://detail.tmall.com/item.htm?id='+String(12345678901+i)).join('\n')),/Batch count/);
});
test('complete/partial/preexisting products are never silently resubmitted',()=>{
 const entry={productId:'644572484093'};
 assert.equal(classifyBatchProduct(entry,{status:'success',workflowStatus:'complete'},true),'skipped_existing_complete');
 assert.equal(classifyBatchProduct(entry,{status:'incomplete',workflowStatus:'incomplete'},true),'skipped_existing_needs_review');
 assert.equal(classifyBatchProduct(entry,null,true),'skipped_existing_needs_review');
 assert.equal(classifyBatchProduct(entry,{status:'incomplete'},false),'skipped_registry_without_receipt');
 assert.equal(classifyBatchProduct(entry,null,false),'ready_for_new_capture');
});

test('batch stops later writes on an uncertain import, timeout or shared failure',()=>{
 assert.equal(shouldHaltBatchAfterAttempt({status:'needs_read_only_recovery',result:{status:'incomplete'}}),true);
 assert.equal(shouldHaltBatchAfterAttempt({status:'needs_read_only_recovery',result:null}),true);
 assert.equal(shouldHaltBatchAfterAttempt({status:'needs_browser_safe_resume',result:{status:'incomplete_before_eagle',error:'Chrome: Tmall access abnormal'}}),true);
 assert.equal(shouldHaltBatchAfterAttempt({status:'complete'}),false);
});
test('batch continues only for proven product-local scan failure with no Eagle writes',()=>{
 const result={status:'incomplete_before_eagle',error:'Chrome: Main/detail images incomplete: main=5 detail=0'};
 const receipt={phase:'incomplete_before_eagle',eagle:'not_called',images:[]};
 assert.equal(shouldHaltBatchAfterAttempt({status:'needs_browser_safe_resume',result,receipt}),false);
 assert.equal(shouldHaltBatchAfterAttempt({status:'needs_browser_safe_resume',result,receipt:{...receipt,eagle:'may_have_submitted'}}),true);
 assert.equal(shouldHaltBatchAfterAttempt({status:'needs_browser_safe_resume',result,receipt:null}),true);
});
