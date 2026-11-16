import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyEagleReadback} from '../scripts/eagle-readback.mjs';

const expected=[{name:'main-001'},{name:'detail-001'},{name:'detail-002'}];
const added=[{id:'a',success:true},{id:'b',success:true},{id:'c',success:true}];
const info=[
 {id:'a',name:'main-001',filePath:'C:/a.jpg',width:800,height:800,ext:'jpg'},
 {id:'b',name:'detail-001',filePath:'C:/b.jpg',width:750,height:1000,ext:'jpg'},
 {id:'c',name:'detail-002',filePath:'C:/c.gif',width:750,height:450,ext:'gif'}
];
test('Eagle eventual-consistency readback retries item_get, not item_add',async()=>{
 let calls=0,waits=0;
 const result=await verifyEagleReadback(expected,added,async ids=>{
  calls++;assert.deepEqual(ids,['a','b','c']);
  return calls===1?info.slice(0,2):info;
 },{delays:[100,500],wait:async()=>{waits++}});
 assert.equal(result.attempts,2);
 assert.equal(waits,1);
 assert.equal(result.records.every(x=>x.verified===true),true);
 assert.deepEqual(result.issues,[]);
});
test('bounded retries leave uncertain items unverified',async()=>{
 let calls=0;
 const result=await verifyEagleReadback(expected,added,async()=>{calls++;return info.slice(0,2)},
 {delays:[0,0],wait:async()=>{}});
 assert.equal(calls,3);
 assert.equal(result.records[2].verified,undefined);
 assert.ok(result.issues.length>0);
});
test('identity conflicts are never fixed by waiting or matching list position',async()=>{
 let calls=0;
 const bad=info.map(x=>({...x}));bad[1].name='main-001';
 const result=await verifyEagleReadback(expected,added,async()=>{calls++;return bad;},
 {delays:[0,0],wait:async()=>{}});
 assert.equal(calls,1);
 assert.ok(result.issues.some(x=>x.includes('duplicate name')));
});
