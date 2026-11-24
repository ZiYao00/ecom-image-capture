import test from 'node:test';
import assert from 'node:assert/strict';
import {requestEagle,eagleFailureDetails} from '../scripts/eagle-request.mjs';
const base='http://127.0.0.1:41595/api/v2/item/get';
const options={delays:[0,0],sleep:async()=>{},timeoutMs:5000};
const network=()=>new TypeError('fetch failed',{cause:Object.assign(new Error('reset'),{code:'ECONNRESET'})});
test('transient Eagle read failures recover within bounded request budget',async()=>{
 let calls=0;
 const out=await requestEagle({...options,endpoint:base,operation:'item_get',fetchFn:async()=>{calls++;if(calls<3)throw network();return {ok:true,json:async()=>({status:'success'})}}});
 assert.equal(calls,3);assert.equal(out.status,'success');
});
test('write transport failure records diagnostics and is never retried',async()=>{
 let calls=0;
 await assert.rejects(()=>requestEagle({...options,endpoint:'http://127.0.0.1:41595/api/v2/item/add',operation:'item_add',fetchFn:async()=>{calls++;throw network()}}),e=>{
  const d=eagleFailureDetails(e);assert.equal(d.outcome,'write_outcome_unknown');assert.equal(d.causeCode,'ECONNRESET');assert.equal(d.route,'/api/v2/item/add');assert.equal(d.attempt,1);return true;
 });assert.equal(calls,1);
});
test('MCP POST reads are retryable, folder mutations remain single attempt',async()=>{
 for(const [operation,expected] of [['folder_get',3],['item_add_to_folders',1],['folder_create',1]]){
  let calls=0;
  await assert.rejects(()=>requestEagle({...options,endpoint:'http://127.0.0.1:41596/mcp',operation,options:{method:'POST'},fetchFn:async()=>{calls++;return{ok:false,status:503}}}),/HTTP 503/);
  assert.equal(calls,expected);
 }
});
test('invalid read payload and unauthorized status are not retried',async()=>{
 for(const response of [{ok:true,json:async()=>{throw new SyntaxError('invalid')}},{ok:false,status:401}]){
  let calls=0;await assert.rejects(()=>requestEagle({...options,endpoint:base,operation:'item_get',fetchFn:async()=>{calls++;return response}}));assert.equal(calls,1);
 }
});
