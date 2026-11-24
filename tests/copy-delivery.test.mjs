import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,existsSync,mkdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ensureCopyDelivery,verifyDeliveryMode} from '../scripts/copy-delivery.mjs';
function setup(){
 const root=mkdtempSync(join(tmpdir(),'ecom-copy-delivery-')),productId='12345678901',outputDir=join(root,productId);
 const items=['main','detail'].map((category,i)=>{
  const bytes=Buffer.from('original-'+i),filePath=join(root,category+'.jpg');writeFileSync(filePath,bytes);
  return {category,order:1,ext:'jpg',filePath,sha256:createHash('sha256').update(bytes).digest('hex')};
 });
 return {snapshot:{status:'complete',productId,items},outputDir};
}
test('copy recovery creates only missing verified local files and preview',async()=>{
 const {snapshot,outputDir}=setup();
 const checked=await ensureCopyDelivery(snapshot,outputDir);assert.equal(checked.status,'incomplete');assert.equal(existsSync(outputDir),false);
 const applied=await ensureCopyDelivery(snapshot,outputDir,{apply:true});
 assert.equal(applied.status,'complete');assert.equal(applied.copied,2);
 assert.equal((await ensureCopyDelivery(snapshot,outputDir)).status,'complete');
 assert.equal((await ensureCopyDelivery(snapshot,outputDir,{apply:true})).copied,0);
});
test('same-sized wrong bytes and hand-edited HTML block copy without overwrite',async()=>{
 const f=setup();mkdirSync(join(f.outputDir,'main'),{recursive:true});
 const dest=join(f.outputDir,'main','01.jpg');writeFileSync(dest,'different!');
 await assert.rejects(()=>ensureCopyDelivery(f.snapshot,f.outputDir,{apply:true}),/Destination content conflict/);
 assert.equal(readFileSync(dest,'utf8'),'different!');
 assert.equal(existsSync(join(f.outputDir,'detail')),false);
 const g=setup();mkdirSync(join(g.outputDir,'detail'),{recursive:true});
 const html=join(g.outputDir,'detail','HTML.html');writeFileSync(html,'manual');
 await assert.rejects(()=>ensureCopyDelivery(g.snapshot,g.outputDir,{apply:true}),/hand-edited/);
 assert.equal(readFileSync(html,'utf8'),'manual');assert.equal(existsSync(join(g.outputDir,'main')),false);
});
test('Eagle and Copy delivery are independent; Eagle mode never creates local copy',async()=>{
 const {snapshot,outputDir}=setup();
 assert.equal((await verifyDeliveryMode(snapshot,{storageMode:'eagle'},{outputDir},{apply:true})).status,'complete');
 assert.equal(existsSync(outputDir),false);
 assert.equal((await verifyDeliveryMode(snapshot,{storageMode:'copy'},{outputDir})).status,'incomplete');
});
