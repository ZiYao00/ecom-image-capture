#!/usr/bin/env node
// Project-owned persistent Chrome Profile: no neighboring Chrome Agent required.
// The user closes this browser window normally; do not kill unknown Chrome processes.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {projectChromePort} from './chrome-connection.mjs';
import {loopbackPortOccupied} from './browser-port.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const action=process.argv[2]||'status';
if(!['status','start'].includes(action)||process.argv.length>3)
  throw Error('Usage: node scripts/browser.mjs [status|start]');
if(process.platform!=='win32')throw Error('Project Chrome launcher currently supports Windows');
const cfgFile=join(root,'config','local.json');
const cfg=existsSync(cfgFile)?JSON.parse(readFileSync(cfgFile,'utf8')):{};
const mode=process.env.CHROME_CONNECTION_MODE||cfg.chromeMode||'project';
if(mode!=='project')throw Error('Browser command is only for chromeMode=project (current: '+mode+')');
const port=projectChromePort(cfg);
const profile=join(root,'runtime','chrome-profile');
const metaFile=join(root,'runtime','browser-instance.json');
const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
const alive=pid=>{
  if(!Number.isInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true}catch{return false}
};
const readMeta=()=>{
  if(!existsSync(metaFile))return null;
  try{return JSON.parse(readFileSync(metaFile,'utf8'))}catch{return null}
};
const debugProbe=async()=>{
  try{
    const response=await fetch('http://127.0.0.1:'+port+'/json/version',
      {signal:AbortSignal.timeout(1300)});
    if(!response.ok)return false;
    return !!(await response.json()).webSocketDebuggerUrl;
  }catch{return false}
};
const state=readMeta();
const portOpen=await debugProbe();
const occupation=await loopbackPortOccupied(port);
if(action==='status'){
  console.log(JSON.stringify({kind:'ecom_project_browser',mode,port,
    status:portOpen?(state&&state.port===port&&alive(state.pid)?'running':'port_conflict'):(occupation.occupied?'port_conflict':'stopped'),
    managedPid:state?.pid||null,profile,owned:!!(portOpen&&state&&state.port===port&&alive(state.pid))},null,2));
  process.exit(0);
}
if(portOpen){
  if(state&&state.port===port&&alive(state.pid)){
    console.log(JSON.stringify({status:'already_running',port,pid:state.pid,profile}));
    process.exit(0);
  }
  throw Error('Port '+port+' is occupied by an unknown browser; choose another chromeDebugPort');
}
if(occupation.occupied)throw Error('TCP port '+port+' is already occupied on '+(occupation.ipv4?'127.0.0.1 ':'')+(occupation.ipv6?'::1':'')+'; choose an unused chromeDebugPort. No process was terminated.');
if(state&&alive(state.pid))throw Error('Previous project Chrome process still running but CDP unavailable; inspect the window instead of starting a duplicate');
const supplied=cfg.chromeExecutablePath;
const candidates=supplied?[resolve(root,supplied)]:[
  join(process.env.PROGRAMFILES||'C:\\Program Files','Google','Chrome','Application','chrome.exe'),
  join(process.env['PROGRAMFILES(X86)']||'C:\\Program Files (x86)','Google','Chrome','Application','chrome.exe'),
  join(process.env.LOCALAPPDATA||'','Google','Chrome','Application','chrome.exe')
];
const executable=candidates.find(p=>existsSync(p));
if(!executable)throw Error('Google Chrome not found; install Chrome or set chromeExecutablePath in config/local.json');
mkdirSync(dirname(metaFile),{recursive:true});
mkdirSync(profile,{recursive:true});
const args=[
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port='+port,
  '--user-data-dir='+profile,
  '--no-first-run','about:blank'
];
const child=spawn(executable,args,{detached:true,windowsHide:false,stdio:'ignore'});
if(!child.pid)throw Error('Could not start Chrome');
child.unref();
writeFileSync(metaFile,JSON.stringify({pid:child.pid,port,profile,startedAt:new Date().toISOString()},null,2)+'\n','utf8');
let online=false;
for(let i=0;i<24;i++){await sleep(350);if(await debugProbe()){online=true;break}}
console.log(JSON.stringify({status:online?'started':'starting',pid:child.pid,port,profile,
  action:'Sign in to Tmall in the opened Chrome window; keep it open while capturing'},null,2));
if(!online)process.exitCode=2;
