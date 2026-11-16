import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateDetailPreview} from '../scripts/html-preview.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),temp=join(root,'data','.capture-store-tests');
mkdirSync(temp,{recursive:true});
test('offline HTML respects numbered order, mixed GIF/JPG, and never changes images',()=>{
 const dir=mkdtempSync(join(temp,'preview-'));
 try{
  const originals=[['02.gif','GIF89a'],['01.jpg','jpegdata'],['03.png','pngdata']];
  for(const [name,body] of originals)writeFileSync(join(dir,name),body);
  const generated=generateDetailPreview(dir,{productId:'123456789012'});
  assert.equal(generated.images,3);assert.equal(generated.status,'generated');
  const html=readFileSync(join(dir,'HTML.html'),'utf8');
  assert.ok(html.indexOf('01.jpg')<html.indexOf('02.gif'));
  assert.ok(html.indexOf('02.gif')<html.indexOf('03.png'));
  assert.ok(!html.includes('https://'));
  assert.equal(generateDetailPreview(dir,{productId:'123456789012'}).status,'unchanged');
  for(const [name,body] of originals)assert.equal(readFileSync(join(dir,name),'utf8'),body);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('preview refuses to overwrite hand-edited HTML without explicit force',()=>{
 const dir=mkdtempSync(join(temp,'preview-'));
 try{
  writeFileSync(join(dir,'01.jpg'),'data');
  writeFileSync(join(dir,'HTML.html'),'personal template');
  assert.throws(()=>generateDetailPreview(dir,{productId:'123456789012'}),/hand-edited/);
  assert.equal(readFileSync(join(dir,'HTML.html'),'utf8'),'personal template');
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('preview rejects missing numbered image sequence',()=>{
 const dir=mkdtempSync(join(temp,'preview-'));
 try{
  writeFileSync(join(dir,'01.jpg'),'data');
  writeFileSync(join(dir,'03.jpg'),'data');
  assert.throws(()=>generateDetailPreview(dir,{productId:'123456789012'}),/sequence/);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
