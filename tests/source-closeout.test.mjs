import test from 'node:test';
import assert from 'node:assert/strict';
import {locateSourceFolder,planSourceCloseout,applySourceCloseout} from '../scripts/source-closeout-core.mjs';
const aa='SOURCEAA1234',target='TARGETMAIN1234',detail='TARGETDETAIL1234',other='OTHERFOLDER123',id='12345678901',sha='a'.repeat(64);
const url='https://detail.tmall.com/item.htm?id='+id+'&skuId=100';
const item={id:'SOURCEITEM123',url,folders:[aa,other]};
const product={status:'complete',skuId:'100',main:target,detail,slots:[]};
test('source folder must be an exact uniquely identified AA or BB',()=>{
 assert.equal(locateSourceFolder([{id:'PARENT123',name:'x',children:[{id:aa,name:'AA'}]}],'AA'),aa);
 assert.equal(locateSourceFolder([{id:aa,name:'bb'}],'BB'),aa);
 assert.throws(()=>locateSourceFolder([{id:aa,name:'AA'},{id:'ANOTHERAA123',name:'AA'}],'AA'),/uniquely/);
});
async function setup(){
 const plan=await planSourceCloseout({folderName:'AA',folderId:aa,libraryPath:'library',items:[item],
  resolveProduct:async()=>product,inspectSource:async()=>({sha256:sha})});
 const rows=new Map([[item.id,{sourceId:item.id,productId:id,skuId:'100',sha256:sha,url,target,folders:[aa,other]}],
 ['NEWITEM1234',{sourceId:'NEWITEM1234',folders:[aa]}]]);
 const logs=[],writes=[];
 const args={plan,libraryPath:'library',folderId:aa,readProof:async row=>structuredClone(rows.get(row.sourceId)),
  link:async(id,fid)=>{writes.push(['link',id,fid]);rows.get(id).folders.push(fid)},
  unlink:async(id,fid)=>{writes.push(['unlink',id,fid]);rows.get(id).folders=rows.get(id).folders.filter(x=>x!==fid)},
  log:e=>logs.push(e)};
 return {plan,rows,logs,writes,args};
}
test('closeout links snapshot sources before removing only source association, leaves later arrivals',async()=>{
 const f=await setup();assert.equal(f.plan.ready.length,1);
 const result=await applySourceCloseout(f.args);
 assert.equal(result.removed,1);assert.equal(result.deletedFiles,0);
 assert.deepEqual(f.rows.get(item.id).folders,[other,target]);assert.deepEqual(f.rows.get('NEWITEM1234').folders,[aa]);
 assert.deepEqual(f.writes.map(x=>x[0]),['link','unlink']);
 assert.equal((await applySourceCloseout(f.args)).alreadyComplete,1);assert.equal(f.writes.length,2);
});
test('changed source hash or unresolved prior intent blocks all mutations',async()=>{
 const f=await setup();f.rows.get(item.id).sha256='b'.repeat(64);
 await assert.rejects(()=>applySourceCloseout(f.args),/identity\/bytes/);assert.equal(f.writes.length,0);
 const g=await setup();
 await assert.rejects(()=>applySourceCloseout({...g.args,priorIntents:[{sourceId:item.id,action:'link',folderId:target}]}),/never replay/);
 assert.equal(g.writes.length,0);
});
test('lost link acknowledgment does not remove source or retry unresolved link',async()=>{
 const f=await setup();
 await assert.rejects(()=>applySourceCloseout({...f.args,link:async()=>{throw Error('lost reply')}}),/lost reply/);
 assert.deepEqual(f.rows.get(item.id).folders,[aa,other]);assert.equal(f.logs.filter(x=>x.event==='intent').length,1);
});
test('unverified product remains pending; exact mapped detail source preserves its target',async()=>{
 const p=await planSourceCloseout({folderName:'AA',folderId:aa,libraryPath:'library',items:[item],
  resolveProduct:async()=>({status:'pending'}),inspectSource:async()=>({sha256:sha})});
 assert.equal(p.ready.length,0);assert.equal(p.pending.length,1);
 const q=await planSourceCloseout({folderName:'AA',folderId:aa,libraryPath:'library',items:[item],
  resolveProduct:async()=>({...product,slots:[{itemId:item.id,category:'detail',sha256:sha}]}),inspectSource:async()=>({sha256:sha})});
 assert.equal(q.ready[0].target,detail);
});
