import test from 'node:test';
import assert from 'node:assert/strict';
import {storageModeFromConfig,eagleOnlyReceiptState} from '../scripts/storage-mode.mjs';
const id='1100960492994';
const item=(verified=true)=>({name:'Tmall-'+id+'-detail-001',category:'detail',itemId:verified?'X1':null,filePath:verified?'C:/Eagle/X1.jpg':null,verified});
test('default stays backward-compatible copy; explicit eagle uses no local image copies',()=>{
 assert.equal(storageModeFromConfig({}),'copy');
 assert.equal(storageModeFromConfig({storageMode:'eagle'}),'eagle');
 assert.throws(()=>storageModeFromConfig({storageMode:'anything'}),/Unsupported/);
});
test('verified Eagle-only capture is successful without local duplicate files',()=>{
 const receipt={productId:id,eagle:'verified',images:[item()],errors:[]};
 const result=eagleOnlyReceiptState(receipt,'C:/AI/Images');
 assert.equal(result.phase,'success');
 assert.equal(result.copied,0);
 assert.equal(result.localStatus,'not_requested');
 assert.equal(result.storageMode,'eagle');
 assert.equal(result.postprocess.html.status,'not_generated_eagle_only');
});
test('unverified Eagle-only capture stays incomplete, never invents success',()=>{
 const receipt={productId:id,eagle:'partially_verified',images:[item(),item(false)]};
 assert.equal(eagleOnlyReceiptState(receipt,'C:/AI/Images').phase,'incomplete');
});
