#!/usr/bin/env node
// Read-only MCP connectivity smoke test. No web navigation, no Eagle item_add.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeConnection } from './chrome-connection.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const help = process.argv.includes('--help');
if (help) {
  console.log('Usage: node scripts/probe-mcp.mjs [--chrome-only|--eagle-only] [--help]');
  console.log('Config: config/local.json (optional), config/local.example.json; env: CHROME_MCP_ENTRY, EAGLE_MCP_URL');
  process.exit(0);
}
const readJson = (name) => {
  const p=join(root, 'config', name);
  if(!existsSync(p)) return {};
  return JSON.parse(readFileSync(p,'utf8'));
};
const config={...readJson('local.example.json'),...readJson('local.json')};
const eagleUrl=process.env.EAGLE_MCP_URL || config.eagleMcpUrl;
const onlyChrome=process.argv.includes('--chrome-only');
const onlyEagle=process.argv.includes('--eagle-only');
if(onlyChrome && onlyEagle) throw Error('Choose only one of --chrome-only / --eagle-only');
let chromeLink=null, chromeConfigError=null;
if(!onlyEagle){
  try{chromeLink=chromeConnection(root,config)}
  catch(e){chromeConfigError=String(e.message||e)}
}
const entry=chromeLink?.entry;
const report={kind:'mcp_readonly_probe',startedAt:new Date().toISOString(),chrome:{status:'skipped'},eagle:{status:'skipped'}};
const elapsed=(t)=>Date.now()-t;
const timeoutRequest=(signal,ms)=>AbortSignal.any([signal,AbortSignal.timeout(ms)]);

async function checkChrome(){
  const start=Date.now();
  if(chromeConfigError)return {status:'failed',stage:'entry',reason:chromeConfigError};
  if(!entry || !existsSync(entry))return {status:'failed',stage:'entry',reason:'Project Chrome MCP missing; run npm ci'};
  const proc=spawn(process.execPath,chromeLink.args,{
    windowsHide:true,env:{...process.env,CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS:'1'}
  });
  let nextId=1,closed=false;
  const pending=new Map();
  const failAll=(why)=>{for(const q of pending.values()){clearTimeout(q.timer);q.reject(new Error(why));}pending.clear();};
  proc.on('error',e=>{closed=true;failAll(e.message)});
  proc.on('exit',()=>{closed=true;failAll('Chrome MCP exited')});
  createInterface({input:proc.stdout}).on('line',(line)=>{
    let obj;try{obj=JSON.parse(line)}catch{return}
    const q=pending.get(obj.id);if(!q)return;
    pending.delete(obj.id);clearTimeout(q.timer);
    obj.error?q.reject(Error(JSON.stringify(obj.error))):q.resolve(obj.result);
  });
  const send=(method,params={},ms=15000)=>new Promise((ok,fail)=>{
    if(closed){fail(Error('Chrome MCP not running'));return;}
    const id=nextId++;
    const timer=setTimeout(()=>{pending.delete(id);fail(Error(method+' timeout'))},ms);
    pending.set(id,{resolve:ok,reject:fail,timer});
    proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
  let stage='initialize';
  try{
    const init=await send('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'ecom-image-capture-probe',version:'0.1'}});
    proc.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    stage='tools/list';
    const tools=await send('tools/list',{},15000);
    const names=(tools.tools||[]).map(t=>t.name);
    if(!names.includes('list_pages'))throw Error('list_pages not found');
    stage='list_pages';
    const pages=await send('tools/call',{name:'list_pages',arguments:{}},30000);
    if(pages?.isError)throw Error('list_pages tool returned isError');
    // Never print or save personal page titles or URLs.
    const pageText=(pages.content||[]).filter(c=>c.type==='text').map(c=>c.text||'').join('\n');
    const count=pageText.split('\n').filter(line=>/^\s*\d+:/.test(line)).length;
    return {status:'passed',mcpVersion:init.serverInfo?.version||'unknown',tools:names.length,visiblePageCount:count,elapsedMs:elapsed(start)};
  }catch(e){return {status:'failed',stage,reason:String(e.message||e).slice(0,300),elapsedMs:elapsed(start)}}
  finally{try{proc.stdin.end()}catch{};if(!proc.killed)proc.kill();}
}
async function eagleCall(method,params={},ms=10000){
  const response=await fetch(eagleUrl,{
    method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0',id:Math.floor(Math.random()*10000000),method,params}),
    signal:timeoutRequest(new AbortController().signal,ms)
  });
  if(!response.ok)throw Error('HTTP '+response.status);
  const body=await response.text();
  const dataLine=body.split(/\r?\n/).find(s=>s.startsWith('data:'));
  const payload=JSON.parse(dataLine?dataLine.slice(5).trim():body);
  if(payload.error||payload.result?.isError)throw Error(JSON.stringify(payload.error||payload.result).slice(0,200));
  return payload.result||payload;
}
async function checkEagle(){
  const start=Date.now();let stage='initialize';
  try{
    if(!eagleUrl)throw Error('Eagle URL missing');
    const init=await eagleCall('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'ecom-image-capture-probe',version:'0.1'}});
    stage='tools/list';
    const list=await eagleCall('tools/list');
    const names=(list.tools||[]).map(t=>t.name);
    const required=['get_app_info','item_add','item_get'];
    const missing=required.filter(name=>!names.includes(name));
    if(missing.length)throw Error('Missing required Eagle MCP tools: '+missing.join(', '));
    stage='get_app_info';
    const info=await eagleCall('tools/call',{name:'get_app_info',arguments:{}},12000);
    if(!info)throw Error('Empty Eagle response');
    return {status:'passed',mcpVersion:init.serverInfo?.version||'unknown',tools:names.length,appInfoReturned:true,elapsedMs:elapsed(start)};
  }catch(e){return {status:'failed',stage,reason:String(e.message||e).slice(0,300),elapsedMs:elapsed(start)}}
}
if(!onlyEagle)report.chrome=await checkChrome();
if(!onlyChrome)report.eagle=await checkEagle();
report.finishedAt=new Date().toISOString();
console.log(JSON.stringify(report,null,2));
if([report.chrome,report.eagle].some(x=>x.status==='failed'))process.exitCode=1;
