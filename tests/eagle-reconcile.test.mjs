import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileEagleItems} from '../scripts/eagle-reconcile.mjs';

const expected=['main-001','main-002','detail-001'].map((name,i)=>({name,order:i+1,category:i<2?'main':'detail'}));
const added=[
 {id:'idC',success:true},{id:'idA',success:true},{id:'idB',success:true}
];
const info=[
 {id:'idB',name:'main-002',filePath:'C:/test/b.jpg',width:800,height:800,ext:'jpg'},
 {id:'idC',name:'detail-001',filePath:'C:/test/c.png',width:790,height:1400,ext:'png'},
 {id:'idA',name:'main-001',filePath:'C:/test/a.jpg',width:800,height:800,ext:'jpg'}
];
test('order-independent name correlation across added and item_get results',()=>{
 const {records,issues}=reconcileEagleItems(expected,added,info);
 assert.deepEqual(issues,[]);
 assert.deepEqual(records.map(x=>x.itemId),['idA','idB','idC']);
 assert.equal(records.every(x=>x.verified===true),true);
 assert.deepEqual(records.map(x=>x.filePath),['C:/test/a.jpg','C:/test/b.jpg','C:/test/c.png']);
});
test('item_get with one missing name never shifts into a different expected record',()=>{
 const {records,issues}=reconcileEagleItems(expected,added,info.filter(x=>x.id!=='idB'));
 assert.equal(records[1].verified,undefined);
 assert.equal(records[0].itemId,'idA');
 assert.equal(records[2].itemId,'idC');
 assert.ok(issues.some(x=>x.includes('main-002')));
});
test('incorrect item names cannot be matched by array index',()=>{
 const wrong=info.map(x=>({...x}));
 wrong[1].name='an-unrelated-name';
 const {records,issues}=reconcileEagleItems(expected,added,wrong);
 assert.ok(issues.some(x=>x.includes('unexpected name')));
 assert.equal(records.find(x=>x.name==='detail-001')?.verified,undefined);
});
test('duplicate item name is ambiguous, no matching asset copied',()=>{
 const bad=info.map(x=>({...x}));
 bad[0].name='main-001';
 const {records,issues}=reconcileEagleItems(expected,added,bad);
 assert.ok(issues.some(x=>x.includes('duplicate name')));
 assert.equal(records.find(x=>x.name==='main-001')?.verified,undefined);
});
test('item_get ID not present in submitted reply is rejected',()=>{
 const bad=info.map(x=>({...x}));
 bad[2].id='never-submitted';
 const {records,issues}=reconcileEagleItems(expected,added,bad);
 assert.ok(issues.some(x=>x.includes('unknown/invalid')));
 assert.equal(records[0].verified,undefined);
});
test('different item_add name for same ID is rejected',()=>{
 const submitted=added.map(x=>({...x}));
 submitted[1].name='wrong-name';
 const {records,issues}=reconcileEagleItems(expected,submitted,info);
 assert.ok(issues.some(x=>x.includes('disagree')));
 assert.equal(records[0].verified,undefined);
});
test('missing dimensions refuse verification even with correct name',()=>{
 const bad=info.map(x=>({...x}));
 bad[2].width=0;
 const {records,issues}=reconcileEagleItems(expected,added,bad);
 assert.equal(records[0].verified,undefined);
 assert.ok(issues.some(x=>x.includes('file/dimensions')));
});
test('expected name collisions are rejected before any mapping',()=>{
 assert.throws(()=>reconcileEagleItems([expected[0],expected[0]],added,info),/duplicate names/);
});
