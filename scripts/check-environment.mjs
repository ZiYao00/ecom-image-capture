#!/usr/bin/env node
// Read-only preflight for the local Tmall capture workflow.
// Uses the existing MCP probe; never navigates, imports to Eagle, starts/stops services,
// writes project data, reads cookies, or reports browser tab titles/URLs.
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromeConnection} from './chrome-connection.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(process.argv.includes('--help')){
  console.log('node scripts/check-environment.mjs');
  console.log('Read-only: Node, Chrome/Eagle MCP, FFmpeg/FFprobe and shared Python Pillow/NumPy.');
  console.log('Capture requires Node + working Chrome/Eagle MCP; stitching and Python tools are optional.');
  process.exit(0);
}
if(process.argv.length>2)throw Error('Unknown arguments; use --help');

const run=(program,args,timeout=15000)=>{
  const r=spawnSync(program,args,{encoding:'utf8',windowsHide:true,
    timeout,maxBuffer:512*1024,stdio:['ignore','pipe','pipe']});
  return {ok:!r.error&&r.status===0,stdout:r.stdout||'',stderr:r.stderr||'',
    reason:r.error?.message||(!r.status&&r.status!==0?'Unable to start process':
      r.status!==0?(r.stderr||'Exit code '+r.status).slice(-350):null)};
};
const failed=(reason)=>({status:'failed',reason:String(reason||'Unknown failure').slice(0,350)});
const readConfig=(name)=>{
  const file=join(root,'config',name);
  return existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
};
const config={...readConfig('local.example.json'),...readConfig('local.json')};
const chromeMode=process.env.CHROME_CONNECTION_MODE||config.chromeMode||'unspecified';
let cdp={status:'skipped',reason:'Only required in project/shared Chrome modes'};
if(chromeMode==='shared'||chromeMode==='project'){
  try{
    const address=chromeConnection(root,config).url;
    const response=await fetch(address+'/json/version',
      {signal:AbortSignal.timeout(3500)});
    if(!response.ok)throw Error('HTTP '+response.status);
    const value=await response.json();
    if(!value.webSocketDebuggerUrl)throw Error('CDP websocket endpoint missing');
    cdp={status:'passed',browser:value.Browser||'unknown'};
  }catch{
    cdp=failed(chromeMode==='project'
      ?'Project Chrome unavailable: run npm ci, then node scripts/browser.mjs start'
      :'Legacy shared Chrome Agent unavailable: verify chromeAgentSettings');
  }
}
const nodeMajor=Number(process.versions.node.split('.')[0]);
const node={status:nodeMajor>=20?'passed':'failed',
  version:process.version,executable:process.execPath};

const executableVersion=(name,override)=>{
  const r=run(override||name,['-version']);
  return r.ok?{status:'passed',version:r.stdout.split(/\r?\n/)[0]}:failed(r.reason);
};
const ffmpeg=executableVersion('ffmpeg',process.env.STITCH_FFMPEG||config.ffmpegExecutablePath);
const ffprobe=executableVersion('ffprobe',process.env.STITCH_FFPROBE||config.ffprobeExecutablePath);

const python=process.env.SHARED_PYTHON||config.sharedPython||
  resolve(root,'..','.tools-venv','Scripts','python.exe');
let sharedPython;
if(!existsSync(python)){
  sharedPython=failed('Shared Python not found at '+python);
}else{
  const program=[
    'import json,sys,io',
    'import numpy as np',
    'import PIL',
    'from PIL import Image',
    'b=io.BytesIO()',
    'Image.new("RGBA",(2,2),(255,255,255,128)).save(b,format="PNG")',
    'b.seek(0)',
    'a=np.asarray(Image.open(b))',
    'assert a.shape==(2,2,4) and int(a[0,0,3])==128',
    'print(json.dumps({"version":sys.version.split()[0],"numpy":np.__version__,"pillow":PIL.__version__,"importAndImageTest":"passed"}))'
  ].join(';');
  const r=run(python,['-B','-c',program],15000);
  try{
    sharedPython=r.ok?{status:'passed',executable:python,...JSON.parse(r.stdout.trim())}:
      failed('Shared Python import check: '+r.reason);
  }catch{
    sharedPython=failed('Shared Python returned non-JSON output');
  }
}

const bundledOCR=resolve(root,'runtime','ocr','.venv','Scripts','python.exe');
const legacyOCR=resolve(root,'..','AI-Runtime','ocr','.venv','Scripts','python.exe');
const ocrPython=process.env.ECOM_OCR_PYTHON||config.ocrPython||
  (existsSync(bundledOCR)?bundledOCR:chromeMode==='shared'&&existsSync(legacyOCR)?legacyOCR:bundledOCR);
let ocr;
if(!existsSync(ocrPython))ocr=failed('Optional RapidOCR runtime not found: '+ocrPython);
else{
  const probe=run(ocrPython,['-B','-c','from rapidocr_onnxruntime import RapidOCR; RapidOCR(); print("ok")'],30000);
  ocr=probe.ok?{status:'passed',python:ocrPython}:failed('RapidOCR import/models check: '+probe.reason);
}

// The project's own probe actually performs MCP initialize/tools/list/list_pages
// and Eagle initialize/tools/list/get_app_info. It does not open tabs or add images.
const probe=run(process.execPath,[join(root,'scripts','probe-mcp.mjs')],85000);
let chrome,eagle;
if(probe.ok){
  try{
    const data=JSON.parse(probe.stdout.trim());
    chrome=data.chrome;
    eagle=data.eagle;
  }catch{
    chrome=failed('Unable to parse Chrome MCP probe response');
    eagle=failed('Unable to parse Eagle MCP probe response');
  }
}else{
  try{
    const data=JSON.parse(probe.stdout.trim());
    chrome=data.chrome||failed('Chrome probe did not return status');
    eagle=data.eagle||failed('Eagle probe did not return status');
  }catch{
    chrome=failed('Chrome/Eagle probe did not finish: '+(probe.reason||'No JSON output'));
    eagle=failed('Chrome/Eagle probe did not finish: '+(probe.reason||'No JSON output'));
  }
}
const ready={
  capture:node.status==='passed'&&(!['shared','project'].includes(chromeMode)||cdp.status==='passed')&&
    chrome?.status==='passed'&&eagle?.status==='passed',
  stitch:node.status==='passed'&&ffmpeg.status==='passed'&&ffprobe.status==='passed',
  pythonImageTools:sharedPython.status==='passed',
  ocr:ocr.status==='passed'
};
console.log(JSON.stringify({kind:'ecom_local_environment_preflight',
  mode:chromeMode,
  readiness:ready,
  checks:{node,cdp,chrome,eagle,ffmpeg,ffprobe,sharedPython,ocr},
  note:'MCP connection tests are read-only. Chrome connectivity does not prove Taobao login; check login only when needed. Optional OCR/stitching/Python checks never block capture.'
},null,2));
if(!ready.capture)process.exitCode=1;
