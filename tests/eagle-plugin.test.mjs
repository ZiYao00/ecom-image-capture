import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Script} from 'node:vm';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
test('source html3 and packaged Eagle window plugin have the same page and parseable JavaScript',()=>{
  const html=readFileSync(join(root,'html3.html'),'utf8');
  const packaged=readFileSync(join(root,'eagle-plugin','index.html'),'utf8');
  assert.equal(html,packaged);
  assert.match(html,/id="eagle-load"/);
  assert.match(html,/function chooseEagleDetailItems\(/);
  assert.match(html,/fileURL/);
  const script=html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script);
  assert.doesNotThrow(()=>new Script(script[1],{filename:'html3-inline.js'}));
});
test('manifest is valid for a resizable standalone Eagle window',()=>{
  const m=JSON.parse(readFileSync(join(root,'eagle-plugin','manifest.json'),'utf8'));
  assert.equal(m.main.url,'index.html');
  assert.equal(m.platform,'win');
  assert.equal(m.main.resizable,true);
  assert.ok(m.main.width>=900&&m.main.height>=650);
  assert.ok(m.id&&m.name);
});
test('self-contained eagleplugin archive contains exactly manifest, PNG and index',()=>{
  const bytes=readFileSync(join(root,'release','Eagle-Detail-Preview-0.1.1.eagleplugin'));
  let off=0;const names=[];
  while(bytes.readUInt32LE(off)===0x04034b50){
    const method=bytes.readUInt16LE(off+8),sz=bytes.readUInt32LE(off+18),
      nameSize=bytes.readUInt16LE(off+26),extra=bytes.readUInt16LE(off+28);
    assert.equal(method,0);
    const name=bytes.toString('utf8',off+30,off+30+nameSize);
    const dataOffset=off+30+nameSize+extra;
    assert.equal(bytes.subarray(dataOffset,dataOffset+sz).compare(readFileSync(join(root,'eagle-plugin',name))),0);
    names.push(name);off=dataOffset+sz;
  }
  assert.deepEqual(names,['manifest.json','logo.png','index.html']);
  const png=readFileSync(join(root,'eagle-plugin','logo.png'));
  assert.equal(png.readUInt32BE(20),128);
  assert.equal(png.readUInt32BE(24),128);
});
