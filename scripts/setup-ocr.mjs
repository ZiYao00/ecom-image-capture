#!/usr/bin/env node
// Optional project-isolated RapidOCR environment. No installation occurs without --install.
import {existsSync,mkdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [action,...rest]=process.argv.slice(2);
if(!['--check','--install',undefined].includes(action)||rest.length)
  throw Error('Usage: node scripts/setup-ocr.mjs [--check|--install]');
const python=join(root,'runtime','ocr','.venv','Scripts','python.exe');
const requirements=join(root,'requirements-ocr.txt');
const run=(exe,args,timeout=90000)=>{
  const r=spawnSync(exe,args,{cwd:root,windowsHide:true,encoding:'utf8',timeout,maxBuffer:128*1024});
  if(r.error||r.status!==0)throw Error(exe+' failed: '+String(r.error||r.stderr||r.stdout).slice(-1400));
  return r.stdout.trim();
};
if(action==='--install'){
  if(process.platform!=='win32')throw Error('This helper currently supports Windows');
  if(!existsSync(python)){
    const source=process.env.ECOM_BASE_PYTHON||'py';
    mkdirSync(join(root,'runtime','ocr'),{recursive:true});
    run(source,source==='py'?['-3','-m','venv',join(root,'runtime','ocr','.venv')]:
      ['-m','venv',join(root,'runtime','ocr','.venv')],90000);
  }
  run(python,['-m','pip','install','-r',requirements,'--disable-pip-version-check'],300000);
}
let status='missing',info=null;
if(existsSync(python)){
  try{
    const output=run(python,['-B','-c',
      'from rapidocr_onnxruntime import RapidOCR; import json; RapidOCR(); print(json.dumps({"ocr":"ready"}))'],40000);
    status='ready';info=JSON.parse(output.split(/\r?\n/).at(-1));
  }catch(e){status='unavailable';info={error:String(e.message||e)}}
}
console.log(JSON.stringify({status,python,installAttempted:action==='--install',detail:info,
  next:status==='missing'?'node scripts/setup-ocr.mjs --install':undefined},null,2));
if(status!=='ready')process.exitCode=1;
