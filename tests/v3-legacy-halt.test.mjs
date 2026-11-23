import test from 'node:test';
import assert from 'node:assert/strict';
import {importEagleInBatches} from '../scripts/eagle-batch.mjs';
test('one uncertain V2 batch halts all later submissions without dropping logical slots',async()=>{
  const source=Array.from({length:9},(_,i)=>({name:'Tmall-1234567890123-detail-'+String(i+1).padStart(3,'0'),
    category:'detail',order:i+1,url:'https://img.alicdn.com/'+i+'.jpg'}));
  let calls=0;
  const r=await importEagleInBatches(source,{
    batchSize:4,delays:[0],exists:()=>true,
    add:async items=>{calls++;return items.map((x,i)=>({itemId:'ITEM'+i,name:x.name,success:true}))},
    read:async()=>source.slice(0,3).map((x,i)=>({id:'ITEM'+i,name:x.name,ext:'jpg',
      filePath:'D:/eagle/'+i+'.jpg',width:750,height:600,folders:['DETAIL']})),
  });
  assert.equal(calls,1);
  assert.equal(r.groups.length,1);
  assert.equal(r.groups[0].status,'partial');
  assert.equal(r.groups[0].unsubmitted,5);
  assert.equal(r.records.length,9);
  assert.equal(r.records.filter(x=>x.submissionStatus==='not_submitted_due_to_prior_uncertain_batch').length,5);
});
