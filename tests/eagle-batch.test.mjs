import test from 'node:test';
import assert from 'node:assert/strict';
import {importEagleInBatches} from '../scripts/eagle-batch.mjs';
const source=Array.from({length:9},(_,n)=>({name:'Tmall-1234567890123-detail-'+String(n+1).padStart(3,'0'),
  category:'detail',order:n+1,url:'https://img.alicdn.com/item-'+n+'.jpg',website:'https://detail.tmall.com/item.htm?id=1234567890123'}));
test('journaled batches submit each source once, verify physical files and classification',async()=>{
  const adds=[],events=[],records=new Map();
  const result=await importEagleInBatches(source,{
    batchSize:4,
    add:async items=>{adds.push(items.map(x=>x.name));return items.map(x=>{
      const id='ID'+(records.size+1);
      records.set(id,{id,name:x.name,ext:'jpg',filePath:'X:/images/'+id+'.info/a.jpg',width:750,height:450,folders:['DETAIL']});
      return {itemId:id,success:true,name:x.name};
    });},
    read:async ids=>ids.map(id=>records.get(id)),
    exists:()=>true,
    record:async e=>events.push(e)
  });
  assert.deepEqual(adds.map(x=>x.length),[4,4,1]);
  assert.equal(new Set(adds.flat()).size,9);
  assert.equal(result.records.filter(x=>x.verified).length,9);
  assert.equal(result.groups.length,3);
  assert.ok(result.groups.every(x=>x.status==='verified'));
  assert.equal(events.filter(x=>x.status==='submitting').length,3);
});
test('acknowledged item with no physical file stays partial; item_add is never retried',async()=>{
  let submissions=0;
  const result=await importEagleInBatches(source.slice(0,1),{
    batchSize:4,
    add:async items=>{submissions++;return [{itemId:'BAD',name:items[0].name,success:true}]},
    read:async()=>[{id:'BAD',name:source[0].name,ext:'jpg',
      filePath:'X:/images/BAD.info/a.jpg',width:750,height:450}],
    exists:()=>false,
    delays:[0],record:()=>{}
  });
  assert.equal(submissions,1);
  assert.equal(result.records[0].verified,false);
  assert.equal(result.groups[0].status,'partial');
});
