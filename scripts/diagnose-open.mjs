#!/usr/bin/env node
// Read-only targeted inspection of an existing Tmall product tab. Does not open or close tabs.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromeConnection} from './chrome-connection.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
// local.json overrides the placeholder template; never read the template alone.
const readCfg=name=>{const p=join(root,'config',name);return existsSync(p)?JSON.parse(readFileSync(p,'utf8')):{}};
const cfg={...readCfg('local.example.json'),...readCfg('local.json')};
const chromeLink=chromeConnection(root,cfg);
const entry=chromeLink.entry;
const id=process.argv[2];
if(!/^[0-9]{8,16}$/.test(id||''))throw Error('Supply a numeric product id');
let processRef,seq=1;
const pending=new Map();
const rpc=(method,params={},maxMs=17000)=>new Promise((res,rej)=>{
 const index=seq++,timer=setTimeout(()=>{pending.delete(index);rej(Error(method+' timeout'))},maxMs);
 pending.set(index,{res,rej,timer});
 processRef.stdin.write(JSON.stringify({jsonrpc:'2.0',id:index,method,params})+'\n');
});
const tool=async(name,args={})=>{
 const x=await rpc('tools/call',{name,arguments:args},35000);
 if(x?.isError)throw Error('MCP error '+name);
 return (x?.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
};
function probe(){
 const area=document.querySelector('#imageTextInfo-content');
 const desc=document.querySelector('.descV8-container');
 const imgs=area?[...area.querySelectorAll('img')]:[];
 const getRect=el=>{const r=el.getBoundingClientRect();return {y:Math.round(r.y),h:Math.round(r.height),w:Math.round(r.width)}};
 const imageData=el=>({src:el.getAttribute('src'),current:el.currentSrc,
  original:el.getAttribute('data-original'),dataSrc:el.getAttribute('data-src'),
  attrs:[...el.attributes].map(a=>[a.name,String(a.value).slice(0,250)]),
  rect:getRect(el),parent:el.parentElement?.outerHTML.slice(0,650)});
 const labels=[...document.querySelectorAll('button,a,[role="tab"],span,div')].filter(el=>{
  const text=(el.textContent||'').trim();
  return text==='图文详情'||text==='详情'||text==='商品详情'||text==='查看详情'||text==='展开更多';
 }).slice(0,30).map(el=>({tag:el.tagName,cls:String(el.className||'').slice(0,120),
  rect:getRect(el),parent:el.parentElement?.outerHTML.slice(0,750)}));
 const frames=[...document.querySelectorAll('iframe')].map(x=>({
  src:x.src,outer:x.outerHTML.slice(0,800),rect:getRect(x),
  sameOriginReadable:(()=>{try{return !!x.contentDocument?.body}catch{return false}})()
 }));
 const blocks=area?[...area.querySelectorAll('*')].filter(el=>String(el.getAttribute('style')||'').includes('background-image')).slice(0,20).map(el=>el.outerHTML.slice(0,500)):[];
 return {host:location.host,title:document.title,url:location.href,scrollY:window.scrollY,
  pageHeight:document.scrollingElement?.scrollHeight,viewport:window.innerHeight,
  areaFound:!!area,areaText:(area?.innerText||'').slice(0,1800),
  areaHtml:(area?.outerHTML||'').slice(0,6500),areaRect:area?getRect(area):null,
  descFound:!!desc,descHtml:(desc?.outerHTML||'').slice(0,6500),
  descNodes:document.querySelectorAll('[class*="descV8"] img').length,areaImages:imgs.map(imageData).slice(0,30),
  tabs:labels,frames,backgrounds:blocks};
}
try {
 processRef=spawn(process.execPath,chromeLink.args,
  {windowsHide:true,env:{...process.env,CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS:'1'}});
 processRef.on('exit',()=>{for(const q of pending.values()){clearTimeout(q.timer);q.rej(Error('process exit'))}pending.clear()});
 createInterface({input:processRef.stdout}).on('line',line=>{
  let x;try{x=JSON.parse(line)}catch{return}
  const q=pending.get(x.id);if(!q)return;
  clearTimeout(q.timer);pending.delete(x.id);
  x.error?q.rej(Error(JSON.stringify(x.error))):q.res(x.result);
 });
 await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'ecom-target-tab-diagnostic',version:'0.1'}});
 processRef.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const pages=await tool('list_pages');
 const matches=[...pages.matchAll(/^\s*(\d+):\s*([^\r\n]+)/gm)]
  .filter(p=>{const m=p[2].match(/https:\/\/detail\.tmall\.com\/item\.htm[^\s\]]+/);if(!m)return false;try{return new URL(m[0]).searchParams.get('id')===id}catch{return false}});
 if(matches.length!==1)throw Error('Expected exactly one target product tab, found '+matches.length+'; will not choose another tab');
 const pageId=Number(matches[0][1]);
 const text=await tool('evaluate_script',{pageId,function:probe.toString()});
 const a=text.indexOf('{'),b=text.lastIndexOf('}');
 if(a<0||b<a)throw Error('No JSON result');
 const result=JSON.parse(text.slice(a,b+1));
 // Minimize persisted/logged data to only this target product page.
 console.log(JSON.stringify(result,null,2));
}catch(e){console.log(JSON.stringify({status:'failed',error:String(e.message||e)}));process.exitCode=2}
finally{if(processRef){try{processRef.stdin.end();processRef.kill()}catch{}}}
