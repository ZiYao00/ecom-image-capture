import test from 'node:test';
import assert from 'node:assert/strict';
import {makeMap,validateMap,compactMap,parseFolderMap,embedFolderMap} from '../scripts/eagle-product-map.mjs';
import {readCurrentEagleProduct} from '../scripts/eagle-current.mjs';
const pid='644572484093',hash='a'.repeat(64);
const imgs=[1,2].map(i=>({name:'Tmall-'+pid+'-detail-'+String(i).padStart(3,'0'),
 category:'detail',order:i,url:'https://gw.alicdn.com/tfs/image-'+i+'.png',
 verified:true,itemId:'EXISTINGITEM01',resolution:'reused',sha256:hash}));
const folder={id:'ROOT01',name:'电商平台批量采集',children:[{id:'PROD01',name:pid,
 children:[{id:'MAINFOLDER01',name:'主图'},{id:'DETAILFOLDER01',name:'详情页'}]}]};
test('one real Eagle item can serve two distinct logical positions',async()=>{
 const map=makeMap(pid,imgs,{folders:{main:'MAINFOLDER01',detail:'DETAILFOLDER01'}});
 assert.equal(map.status,'complete');
 assert.equal(new Set(map.slots.map(x=>x.itemId)).size,1);
 const item={id:'EXISTINGITEM01',name:'Tmall-947780804552-detail-022',filePath:'mock',
 ext:'png',folders:['DETAILFOLDER01'],width:1125,height:231};
 const rpc=async(tool,args)=>{
  if(tool==='folder_get')return [folder];
  if(tool==='item_get')return args.folders.includes('DETAILFOLDER01')?[item]:[];
  throw Error('Unexpected RPC '+tool);
 };
 const result=await readCurrentEagleProduct({rpc,productId:pid,images:imgs,productMap:map,
  inspectFile:async()=>({filePath:'D:/images/EXISTINGITEM01.info/original.png',bytes:333,sha256:hash})});
 assert.equal(result.status,'complete');
 assert.equal(result.counts.detail,2);
 assert.equal(result.items.length,2);
 assert.equal(result.items[0].name,imgs[0].name);
 assert.equal(result.items[0].eagleName,item.name);
 assert.equal(result.items[1].id,result.items[0].id);
 assert.equal(result.unrelated.length,0);
});
test('description embeds mapping while preserving existing user notes',()=>{
 const map=makeMap(pid,imgs);
 const desc=embedFolderMap('My existing notes',map,'detail');
 const parsed=parseFolderMap(desc);
 assert.equal(parsed.pid,pid);
 assert.deepEqual(parsed.items,[[1,'EXISTINGITEM01'],[2,'EXISTINGITEM01']]);
 assert.ok(desc.startsWith('My existing notes'));
 assert.equal(embedFolderMap(desc,map,'detail'),desc);
 assert.equal(parseFolderMap('ordinary user description'),null);
 assert.throws(()=>parseFolderMap('[ECOM-PRODUCT-MAP-V1]\nhello'),/Ambiguous/);
});
test('source, order, and SHA conflicts are rejected',()=>{
 const map=makeMap(pid,imgs);
 assert.throws(()=>validateMap(map,[{...imgs[0],url:'https://changed.invalid'},{...imgs[1]}]),/source conflict/);
 assert.throws(()=>validateMap({...map,slots:[map.slots[0],map.slots[0]]}),/Duplicate/);
 assert.throws(()=>validateMap({...map,slots:[map.slots[1]]}),/Noncontiguous/);
});
