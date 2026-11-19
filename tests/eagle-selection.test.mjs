import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=readFileSync(join(root,'html3.html'),'utf8');
const start=source.indexOf('  // Never let Eagle');
const stop=source.indexOf('  function displayEagleItems(',start);
assert.ok(start>0&&stop>start,'Eagle helper block available');
const helpers=source.slice(start,stop);
const product='1100960492994',other='1100960492995',folderId='DETAIL-1';
function item(pid,n,folders=[folderId]){
 return {id:pid+'-'+n,name:'Tmall-'+pid+'-detail-'+String(n).padStart(3,'0'),
  ext:'jpg',fileURL:'file:///mock/'+pid+'/'+n+'.jpg',folders};
}
function mock({selected=[],selectedFolders=[],extra=[],searchResults=[]}={}){
 const folders={
 [folderId]:{id:folderId,name:'详情页',parent:product},
 [product]:{id:product,name:product,parent:'BATCH',children:[{id:folderId,name:'详情页',parent:product}]},
 ROOT:{id:'ROOT',name:'全部',children:[]}
 };
 const calls=[];
 const api={
  folder:{
   getSelected:async()=>selectedFolders,
   getById:async id=>folders[id]||null
  },
  item:{
   getSelected:async()=>selected,
   get:async options=>{
    calls.push(options);
    return options.folders?extra:searchResults;
   }
  }
 };
 const context={
  window:{eagle:api},
  eaglePattern:/^(?:Tmall|Taobao)-(\d{8,16})-detail-(\d{3,4})$/,
  validExt:/\.(?:png|jpe?g|webp|gif)$/i,
  eagleFileUrl:x=>x.fileURL,
  Error,Set,Number,String,Array
 };
 const funcs=runInNewContext(helpers+'\n({chooseEagleDetailItems,filterEagleDetailRows})',context);
 return {...funcs,calls};
}
test('single selected picture wins over selected All/batch folder',async()=>{
 const m=mock({selected:[item(product,2)],selectedFolders:[{id:'ROOT',name:'全部'}],
   extra:[item(product,1),item(product,2),item(other,3)]});
 const choice=await m.chooseEagleDetailItems();
 assert.equal(choice.productId,product);
 assert.equal(choice.folderId,folderId);
 assert.equal(m.calls.length,1);
 assert.deepEqual([...m.calls[0].folders],[folderId]);
 const rows=m.filterEagleDetailRows(choice.items,choice.productId,choice.folderId);
 assert.deepEqual(Array.from(rows,x=>x.order),[1,2]);
});
test('explicit detail folder filters out extraneous other products returned by SDK',async()=>{
 const m=mock({selectedFolders:[{id:folderId,name:'详情页'}],
  extra:[item(product,2),item(other,6),item(product,1),item(product,7,['OTHER'])]});
 const choice=await m.chooseEagleDetailItems();
 assert.equal(choice.productId,product);
 assert.equal(choice.folderId,folderId);
 const rows=m.filterEagleDetailRows(choice.items,choice.productId,choice.folderId);
 assert.deepEqual(Array.from(rows,x=>x.order),[1,2]);
});
test('selected image with no product folder falls back to keywords, but filters exact ID',async()=>{
 const m=mock({selected:[item(product,3,['OTHER'])],selectedFolders:[{id:'ROOT',name:'全部'}],
  searchResults:[item(other,1),item(product,3),item(product,2)]});
 const choice=await m.chooseEagleDetailItems();
 assert.equal(choice.folderId,null);
 assert.deepEqual(Array.from(m.filterEagleDetailRows(choice.items,choice.productId,choice.folderId),x=>x.order),[2,3]);
});
test('mixed item selection rejected, no fallback to all items',async()=>{
 const m=mock({selected:[item(product,2),item(other,1)]});
 await assert.rejects(()=>m.chooseEagleDetailItems(),/多个商品/);
 assert.equal(m.calls.length,0);
});
test('explicit detail folder wins over stale selected image from another product',async()=>{
 const m=mock({selected:[item(other,1,['OTHER'])],selectedFolders:[{id:folderId,name:'详情页'}],extra:[item(product,1),item(other,2)]});
 const choice=await m.chooseEagleDetailItems();
 assert.equal(choice.productId,product);
 assert.deepEqual(Array.from(m.filterEagleDetailRows(choice.items,choice.productId,choice.folderId),x=>x.order),[1]);
});
test('selected product parent folder finds details and scopes to its ID',async()=>{
 const m=mock({selectedFolders:[{id:product,name:product}],extra:[item(product,1),item(other,2)]});
 const choice=await m.chooseEagleDetailItems();
 assert.equal(choice.folderId,folderId);
 assert.equal(choice.productId,product);
 assert.deepEqual(Array.from(m.filterEagleDetailRows(choice.items,choice.productId,choice.folderId),x=>x.order),[1]);
});
