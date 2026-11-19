import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const powershell=join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const cli=join(root,'scripts','ecom.mjs');
const call=(args)=> {
 const r=spawnSync(process.execPath,[cli,...args],{
  cwd:root,encoding:'utf8',timeout:15000,windowsHide:true
 });
 return {status:r.status,error:r.error,output:JSON.parse(r.stdout)};
};
test('Agent and user share a single machine-readable CLI',()=>{
 const r=call(['help']);
 assert.equal(r.status,0);
 assert.equal(r.output.tool,'ecom-image-capture');
 assert.equal(r.output.status,'help');
 assert.equal(r.output.exitCodes[10].startsWith('needs action'),true);
});
test('invalid capture URLs stop before browser/Eagle execution',()=>{
 for(const target of ['garbage','https://example.com','http://detail.tmall.com/item.htm?id=1050012712486']){
  const r=call(['capture',target]);
  assert.equal(r.status,2);
  assert.equal(r.output.status,'invalid_url');
 }
});
test('Eagle-only stitching and archive commands reject unsafe IDs before any API call',()=>{
  for(const args of [['stitch-eagle','bad'],['stitch-eagle','../bad'],['archive','bad']]){
    const r=call(args);
    assert.equal(r.status,2);
    assert.equal(r.output.status,'invalid_arguments');
  }
});
test('resume never takes an invalid product id',()=>{
 const r=call(['resume','not-an-id']);
 assert.equal(r.status,2);
 assert.equal(r.output.status,'invalid_product_id');
});
test('unknown command and malformed HTML command do not touch product receipts',()=>{
 const invalid=call(['bogus']);
 assert.equal(invalid.status,2);
 assert.equal(invalid.output.status,'help');
 const html=call(['html']);
 assert.equal(html.status,2);
 assert.equal(html.output.status,'invalid_arguments');
});
test('PowerShell prereq check never installs system software',{skip:process.platform!=='win32'},()=>{
 const r=spawnSync(existsSync(powershell)?powershell:'powershell.exe',
  ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
   '-File',join(root,'install.ps1'),'-CheckOnly'],{
    cwd:root,encoding:'utf8',windowsHide:true,timeout:20000,
    env:{...process.env,ECOM_NODE_EXE:process.execPath}
   });
 assert.ok([0,10].includes(r.status),r.stderr||r.stdout);
 const state=JSON.parse(r.stdout);
 assert.equal(state.phase,'windows_prerequisites');
 assert.equal(state.installedByThisRun.length,0);
 assert.ok(['needs_action','prerequisites_found'].includes(state.status));
});
