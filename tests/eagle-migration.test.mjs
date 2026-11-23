import test from 'node:test';
import assert from 'node:assert/strict';
import {planUnifiedFolderMigration} from '../scripts/eagle-migration-core.mjs';
import {ECOM_ARCHIVE_ROOT} from '../scripts/eagle-archive.mjs';
const product=(id)=>({id:'F'+id,name:id,children:[
  {id:'M'+id,name:'主图',children:[]},{id:'D'+id,name:'详情页',children:[]}
]});
test('chooses the populous old root as rename anchor and moves the other products',()=>{
  const roots=[
    {id:'R1',name:'天猫批量采集_2026-11-17',children:[product('12345678901'),product('12345678902')]},
    {id:'R2',name:'天猫批量采集_2026-11-18',children:[product('12345678903')]}
  ];
  const p=planUnifiedFolderMigration(roots);
  assert.equal(p.status,'ready');assert.equal(p.anchor.id,'R1');
  assert.equal(p.rootName,ECOM_ARCHIVE_ROOT);
  assert.equal(p.move.length,1);assert.equal(p.move[0].sourceRootId,'R2');
  assert.equal(p.products.length,3);
});
test('uses existing unified root; no dated folder recreated after migration',()=>{
  const roots=[{id:'R1',name:ECOM_ARCHIVE_ROOT,children:[product('12345678901')]},
    {id:'R2',name:'天猫批量采集_2026-11-18',children:[product('12345678902')]}];
  assert.equal(planUnifiedFolderMigration(roots).move.length,1);
  const done=planUnifiedFolderMigration([{...roots[0],children:[...roots[0].children,...roots[1].children]},
    {...roots[1],children:[]}]);
  assert.equal(done.status,'already_unified');
});
test('Legacy root consolidation never flattens industry-nested products',()=>{
  const nested={id:'IND-ADULT',name:'成人用品',children:[product('12345678901')]};
  const p=planUnifiedFolderMigration([{id:'R1',name:ECOM_ARCHIVE_ROOT,children:[nested]}]);
  assert.equal(p.status,'already_unified');
  assert.equal(p.move.length,0);
  assert.equal(p.products[0].parentId,'IND-ADULT');
  assert.equal(p.products[0].nested,true);
});
test('refuses duplicated products and ambiguous folder structures',()=>{
  assert.throws(()=>planUnifiedFolderMigration([
    {id:'R1',name:ECOM_ARCHIVE_ROOT,children:[product('12345678901')]},
    {id:'R2',name:'天猫批量采集_2026-11-18',children:[product('12345678901')]}
  ]),/Conflicting/);
  assert.throws(()=>planUnifiedFolderMigration([{id:'R1',name:ECOM_ARCHIVE_ROOT,
    children:[{id:'F',name:'12345678901',children:[]}]}]),/missing\/ambiguous/);
});
