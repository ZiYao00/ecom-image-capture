import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBatchOptions,classifyBatchProduct,collectBatchBarriers,runBatchQueue,BATCH_BUDGETS} from '../scripts/batch-core.mjs';
const a={index:1,productId:'12345678901',skuId:'100',fullUrl:'https://detail.tmall.com/item.htm?id=12345678901&skuId=100'};
const b={index:2,productId:'12345678902',skuId:'200',fullUrl:'https://detail.tmall.com/item.htm?id=12345678902&skuId=200'};
test('batch engine is explicit and V2 remains default; outer child budgets cover nested CLI',()=>{
 assert.equal(parseBatchOptions(['a.json']).engine,'v2');
 assert.deepEqual(parseBatchOptions(['a.json','--engine','v3','--apply']),{file:'a.json',mode:'--apply',engine:'v3'});
 assert.throws(()=>parseBatchOptions(['a.json','--engine','v4']),/Invalid/);
 assert.ok(BATCH_BUDGETS.capture>45000+90000+420000);
 assert.ok(BATCH_BUDGETS.recovery>840000);
});
test('SKU conflict and unknown identities are never silently skipped as completed',()=>{
 const done={status:'success',workflowStatus:'complete',skuId:'100'};
 assert.equal(classifyBatchProduct(a,done,true,{skuId:'100'}),'skipped_existing_complete');
 assert.equal(classifyBatchProduct({...a,skuId:'101'},done,true,{skuId:'100'}),'existing_sku_conflict');
 assert.equal(classifyBatchProduct(a,done,true,{skuId:'101'}),'existing_sku_conflict');
 assert.equal(classifyBatchProduct({...a,skuId:null},done,true,{skuId:'100'}),'existing_sku_unknown');
 assert.equal(classifyBatchProduct(a,null,false,null,true),'existing_sku_unknown');
 assert.equal(classifyBatchProduct(a,null,false),'ready_for_new_capture');
});
test('prior persisted unresolved attempts and orphan V3 journals block new writes',()=>{
 const journals=[{items:[{productId:a.productId,status:'invoking_capture'},{productId:b.productId,status:'needs_browser_safe_resume',zeroWriteLocalScan:true}]}];
 assert.deepEqual(collectBatchBarriers({journals}).map(x=>x.productId),[a.productId]);
 assert.deepEqual(collectBatchBarriers({journals,products:{[a.productId]:{status:'success',workflowStatus:'complete'}}}),[]);
 assert.equal(collectBatchBarriers({jobs:[{productId:b.productId,state:'planned',slots:[{state:'planned'}]}]}).length,1);
});
function setup(overrides={}){
 const events=[],rows=[];
 const base={entries:[a,b],engine:'v3',classify:()=> 'ready_for_new_capture',barriers:()=>[],
  run:(kind,x)=>{events.push([kind,x.productId]);return{ok:true,result:{status:'complete'},recovered:kind==='recover'}},
  saveRow:(x,r)=>rows.push({id:x.productId,...r}),canRecover:()=>true,
  refreshIndex:()=>{events.push(['index']);return{ok:true}},
  verifyDelivery:(x,o)=>{events.push(['verify',x.productId,!!o?.apply]);return{ok:true,result:{status:'complete'}}}};
 return {events,rows,result:runBatchQueue({...base,...overrides})};
}
test('V3 batch uses one safe recovery then independent finalization before continuing',()=>{
 const order=[];
 const f=setup({run:(kind,x)=>{order.push([kind,x.productId]);if(kind==='capture'&&x===a)return{ok:false,result:{status:'incomplete'},code:2};return{ok:true,recovered:kind==='recover'};}});
 assert.deepEqual(order,[['capture',a.productId],['recover',a.productId],['capture',b.productId]]);
 assert.deepEqual(f.result.summary.map(x=>x.status),['complete','complete']);
 assert.ok(f.events.some(x=>x[0]==='verify'&&x[1]===a.productId&&x[2]===true));
});
test('timeout or uncertain child does not trigger automatic recovery or later captures',()=>{
 let calls=0;
 const f=setup({run:()=>{calls++;return{ok:false,uncertainProcess:true}},canAutoRecover:x=>!x.uncertainProcess});
 assert.equal(calls,1);assert.equal(f.result.summary[1].status,'not_started_due_to_batch_halt');
});
test('new queue cannot bypass unresolved earlier batch attempt',()=>{
 const f=setup({barriers:()=>[{productId:'12345678909',reason:'unresolved_prior_batch_attempt'}]});
 assert.equal(f.events.length,0);assert.equal(f.result.summary[0].status,'blocked_by_prior_attempt');
});
test('completed entries are independently verified without a new capture; failed verification halts',()=>{
 const f=setup({classify:()=> 'skipped_existing_complete',verifyDelivery:()=>({ok:false})});
 assert.equal(f.events.length,0);assert.equal(f.result.summary[0].status,'needs_read_only_recovery');
 assert.equal(f.result.summary[1].status,'not_started_due_to_batch_halt');
});
test('V2 runner never selects V3 recovery implicitly',()=>{
 let calls=0;
 const f=setup({engine:'v2',run:()=>{calls++;return{ok:false,result:{status:'incomplete'}}}});
 assert.equal(calls,1);assert.equal(f.result.summary[1].status,'not_started_due_to_batch_halt');
});
