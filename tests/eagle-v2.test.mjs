import test from 'node:test';
import assert from 'node:assert/strict';
import {findProductArchive} from '../scripts/eagle-current.mjs';
import {ECOM_ARCHIVE_ROOT} from '../scripts/eagle-archive.mjs';
import {captureSummary} from '../scripts/capture-store.mjs';
const id='1024881530158';
const product=()=>({id:'PROD',name:id,children:[{id:'M',name:'主图'},{id:'D',name:'详情页'}]});
test('historical dated receipt resolves its unique migrated product',()=>{
  const roots=[{id:'ROOT',name:ECOM_ARCHIVE_ROOT,children:[product()]},
    {id:'EMPTY',name:'天猫批量采集_2026-11-20',children:[]}];
  const found=findProductArchive(roots,id,{rootName:'天猫批量采集_2026-11-20'});
  assert.equal(found.rootName,ECOM_ARCHIVE_ROOT);
  assert.equal(found.detailFolderId,'D');
  assert.throws(()=>findProductArchive([...roots,
    {id:'OLD',name:'天猫批量采集_2026-11-20',children:[product()]}],id,
    {rootName:'天猫批量采集_2026-11-20'}),/Ambiguous/);
});
test('auto-stitch failure never reports complete workflow; legacy receipts stay backward compatible',()=>{
  const base={productId:id,phase:'success',eagle:'verified',
    images:[{category:'main',order:1,verified:true},{category:'detail',order:1,verified:true}],
    selected:{main:1,detail:1},archive:{status:'complete'},storageMode:'eagle'};
  assert.equal(captureSummary({...base,autoStitchEnabled:true,
    postprocess:{stitch:{status:'needs_read_only_review'}}}).workflowStatus,'incomplete');
  assert.equal(captureSummary({...base,autoStitchEnabled:true,
    postprocess:{stitch:{status:'complete'}}}).workflowStatus,'complete');
  assert.equal(captureSummary(base).workflowStatus,'complete');
});
