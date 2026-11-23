import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyProductTitle,classifyManual,INDUSTRIES,isConfidentClassification,
  industryTag,subcategoryTag,isManagedTag} from '../scripts/industry-core.mjs';
import {captureSummary,updateProduct,readRegistry} from '../scripts/capture-store.mjs';
import{mkdtempSync,mkdirSync,writeFileSync,rmSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
const samples=[
 ['跳蛋小海豚女用品情趣自慰器情侣远程遥控','adult','female'],
 ['SM情趣道具女性插入式跳蛋','adult','female'],
 ['2026年新款胶囊充电宝口红超小便携','electronics','powerbank'],
 ['图拉斯大眼仔屏显充电器 AVS 60W Type-C数据线一套','electronics','charger'],
 ['蕉调胸贴女防走光隐形硅胶乳贴','apparel','chestpad'],
 ['蕉调灰色打底裤女秋冬显瘦连裤袜','apparel','leggings'],
];
for(const [title,industry,sub] of samples)
 test('Industry classifies product nouns '+industry+'/'+sub+': '+title.slice(0,12),()=>{
  const c=classifyProductTitle(title);
  assert.equal(c.industryCode,industry);
  assert.equal(c.subcategoryCode,sub);
  assert.equal(c.status,'auto_confirmed');assert.ok(c.evidence.length);
 });
test('AVS/3C certification alone never identifies adult or electronics',()=>{
  for(const title of ['AVS 2026技术海报','3C认证可上飞机','迷你小巧便携','女性用品推荐'])
    assert.equal(classifyProductTitle(title).status,'needs_review',title);
});
test('Contradictory real nouns are held for review and no forced classification',()=>{
  const c=classifyProductTitle('跳蛋充电宝组合商品');
  assert.equal(c.status,'needs_review');assert.equal(c.reason,'cross_industry_conflict');
});
test('Canonical codes and managed Eagle tags are distinct and stable',()=>{
  assert.equal(INDUSTRIES.electronics.label,'3C数码');
  assert.equal(industryTag('electronics'),'采集行业｜3C数码');
  assert.equal(subcategoryTag('electronics','powerbank'),'采集子类｜3C数码／充电宝');
  assert.equal(isManagedTag('设计精选'),false);
  assert.equal(isManagedTag(industryTag('adult')),true);
  assert.throws(()=>classifyManual('electronics','toy'),/Unknown/);
});
test('Capture summary computes taxonomy from title without modifying capture status',()=>{
  const x=captureSummary({productId:'123456789012',phase:'incomplete',title:'快充充电宝自带线',images:[],selected:{main:0,detail:0}});
  assert.equal(x.classification.industryCode,'electronics');
  assert.equal(x.status,'incomplete');
  assert.equal(x.workflowStatus,'incomplete');
});
test('Industry-only update preserves legacy Taobao URL and existing capture metadata',async()=>{
  const root=mkdtempSync(join(tmpdir(),'industry-legacy-'));
  try{
    mkdirSync(join(root,'data'));
    const id='1051888739455',url='https://item.taobao.com/item.htm?id='+id;
    writeFileSync(join(root,'data','captures.json'),JSON.stringify({schemaVersion:1,
      products:{[id]:{productId:id,url,status:'incomplete',workflowStatus:'incomplete',
        mainCount:5,detailCount:0}}}));
    const {updateProductClassification}=await import('../scripts/capture-store.mjs');
    await updateProductClassification(root,id,classifyProductTitle('手机快充充电器'));
    const saved=readRegistry(root).products[id];
    assert.equal(saved.url,url);
    assert.equal(saved.mainCount,5);
    assert.equal(saved.workflowStatus,'incomplete');
    assert.equal(saved.classification.industryCode,'electronics');
  }finally{rmSync(root,{force:true,recursive:true})}
});
test('Manual industry classification cannot be overridden by a future capture update',async()=>{
  const root=mkdtempSync(join(tmpdir(),'industry-manual-'));
  try{
    mkdirSync(join(root,'data'));
    writeFileSync(join(root,'data','captures.json'),JSON.stringify({schemaVersion:1,products:{}}));
    const id='123456789012';
    await updateProduct(root,{productId:id,classification:classifyManual('apparel','chestpad')});
    await updateProduct(root,{productId:id,status:'success',classification:classifyProductTitle('充电宝移动电源')});
    const product=readRegistry(root).products[id];
    assert.equal(product.classification.industryCode,'apparel');
    assert.equal(product.classification.subcategoryCode,'chestpad');
    assert.equal(product.classification.manualLocked,true);
    assert.equal(product.status,'success');
  }finally{rmSync(root,{force:true,recursive:true})}
});
