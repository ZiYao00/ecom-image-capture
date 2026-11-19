import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const cli=join(root,'scripts','ecom.mjs');
const call=(args)=>{
  const r=spawnSync(process.execPath,[cli,...args],{
    cwd:root,windowsHide:true,encoding:'utf8',timeout:15000
  });
  return {exit:r.status,response:JSON.parse(r.stdout)};
};
test('stitch is advertised in the unified CLI without starting capture',()=>{
  const r=call(['help']);
  assert.equal(r.exit,0);
  assert.ok(r.response.usage.some(x=>x.includes('stitch')));
});
test('stitch rejects malformed input before invoking FFmpeg or Eagle',()=>{
  for(const args of [['stitch'],['stitch','no'],['stitch','123456789012','0'],
    ['stitch','123456789012','99999'],['stitch','123456789012','750','extra']]){
    const r=call(args);
    assert.equal(r.exit,2);
    assert.equal(r.response.status,'invalid_arguments');
  }
});
