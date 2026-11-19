#!/usr/bin/env node
// Stable Tmall capture: one Chrome product tab, adaptive image loading, one Eagle batch,
// then direct copies of verified local images. Original benchmark files remain untouched.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync, statSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { chromeConnection } from './chrome-connection.mjs';
import { reconcileEagleItems } from './eagle-reconcile.mjs';
import {repairCopyState} from './recovery-core.mjs';
import {captureSummary,updateProduct,readRegistry,acquireProductLock} from './capture-store.mjs';
import {resolveOutputRoot} from './capture-policy.mjs';
import {verifyEagleReadback} from './eagle-readback.mjs';
import {generateDetailPreview} from './html-preview.mjs';
import {archiveEagleProduct, archiveRootForDate, eagleArchiveRpc} from './eagle-archive.mjs';
import {storageModeFromConfig, eagleOnlyReceiptState} from './storage-mode.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const normalize = s => s.replace(/(\.png|\.jpe?g)_q\d+\.jpg_\.webp$/i, '$1')
  .replace(/(\.png|\.jpe?g)_\d+x\d+.*$/i, '$1');
const isCdn = u => /^https:\/\/(?:[a-z0-9-]+\.)*(?:alicdn\.com|taobaocdn\.com|tbcdn\.cn)\//i.test(u);
const isPlatform = u => /!!600000000\d+/.test(u) || /\/600000000\d+\//.test(u);
// Note on image identity: URLs look like
//   /imgextra/i4/2214789435593/O1CN01abc_!!2214789435593.jpg
// where 2214789435593 is the SELLER id and is identical for every image of that shop.
// Never dedup on the numeric segment or on !!<number>; that collapses the whole gallery.
// Dedup uses normalize(), which only strips CDN size/quality suffixes and leaves
// ~crop,x,y,w,h~ segments intact so long images split into parts stay separate.
const cleanUrl = value => {
  if (typeof value !== 'string') return '';
  let s = value.trim().replace(/&amp;/g, '&');
  if (s.startsWith('//')) s = 'https:' + s;
  return isCdn(s) ? s : '';
};
const unique = (images, type) => {
  const seen = new Set(), output = [];
  for (const im of images) {
    // Main images have always been normalized; keep that behaviour unchanged.
    const url = type === 'main' ? normalize(cleanUrl(im.url)) : cleanUrl(im.url);
    if (!url || (type === 'detail' && isPlatform(url))) continue;
    // Detail images repeat as CDN size/quality variants of one file. Normalize only the
    // known size suffix for the dedup key; keep the exact loaded URL for download.
    // ~crop,x,y,w,h~ segments are distinct parts of a long image and MUST NOT collapse.
    const key = type === 'detail' ? normalize(url) : url;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ url, category: type, order: output.length + 1 });
  }
  return output;
};
const readCfg = filename => {
  const path = join(root, 'config', filename);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
};
const config = { ...readCfg('local.example.json'), ...readCfg('local.json') };
const started = performance.now(), ms = () => Math.round(performance.now() - started);
const receiptSave = (path, data) => {
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
};
function copyAssets(receipt, destRoot) {
  let copied = 0, errors = [];
  const id = receipt.productId;
  for (const item of receipt.images || []) {
    if (!item.verified || !item.filePath || !existsSync(item.filePath)) {
      errors.push('Missing verified Eagle file ' + item.category + '-' + item.order);
      continue;
    }
    const ext = String(item.ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const dest = join(destRoot, id, item.category, String(item.order).padStart(2, '0') + '.' + ext);
    try {
      mkdirSync(dirname(dest), { recursive: true });
      if (existsSync(dest)) {
        if (statSync(dest).size !== statSync(item.filePath).size) throw Error('Destination file conflict');
      } else {
        copyFileSync(item.filePath, dest);
      }
      if (statSync(dest).size === 0 || statSync(dest).size !== statSync(item.filePath).size) throw Error('Copy invalid');
      copied++;
    } catch (e) {
      errors.push(item.category + '-' + item.order + ': ' + e.message);
    }
  }
  return { copied, errors, destination: join(destRoot, id) };
}
if (args[0] === '--self-test') {
  const examples = [
    ['https://gw.alicdn.com/imgextra/O1CN001.jpg_q50.jpg_.webp', true, 'https://gw.alicdn.com/imgextra/O1CN001.jpg'],
    ['https://img.alicdn.com/imgextra/i2/12345678/A.jpg', true, 'https://img.alicdn.com/imgextra/i2/12345678/A.jpg'],
    ['https://img.alicdn.com/imgextra/i2/O1CN_x_!!6000000002222-2-tps-12-12.png', true, 'https://img.alicdn.com/imgextra/i2/O1CN_x_!!6000000002222-2-tps-12-12.png'],
    ['data:image/png;base64,abc', false, ''],
    ['https://example.com/image.jpg', false, '']
  ];
  for (const [u, expected, result] of examples) {
    if (!!cleanUrl(u) !== expected) throw Error('CDN parser self-test failed');
    if (normalize(cleanUrl(u)) !== result) throw Error('Normalization self-test failed');
  }
  if (unique([{url:examples[0][0]},{url:examples[0][2]},{url:examples[1][0]}], 'main').length !== 2)
    throw Error('Main dedup self-test failed');
  if (unique([{url:examples[1][0]},{url:examples[2][0]}], 'detail').length !== 1)
    throw Error('Platform filter self-test failed');
  // Same asset at two CDN sizes must collapse; two ~crop~ segments of one long image must not.
  const detA   = 'https://img.alicdn.com/imgextra/i1/2222848616311/O1CN018Kt2HJ1wUUj9Yqs6M~crop,0,0,790,1580~_!!2222848616311.jpg';
  const detB   = 'https://img.alicdn.com/imgextra/i1/2222848616311/O1CN018Kt2HJ1wUUj9Yqs6M~crop,0,1580,790,150~_!!2222848616311.jpg';
  const sizeA  = 'https://img.alicdn.com/imgextra/i4/2214789435593/O1CN01abc_!!2214789435593.jpg_800x800.jpg';
  const sizeB  = 'https://img.alicdn.com/imgextra/i4/2214789435593/O1CN01abc_!!2214789435593.jpg_q90.jpg_.webp';
  if (unique([{url:detA},{url:detB}], 'detail').length !== 2)
    throw Error('Crop-segment self-test failed: long-image parts must stay separate');
  if (unique([{url:sizeA},{url:sizeB}], 'detail').length !== 1)
    throw Error('Size-variant self-test failed: same asset must collapse');
  console.log('PASS: URL parsing, deduplication, platform filter, crop segments, size variants');
  process.exit(0);
}
if (args[0] === '--help' || args.length < 1) {
  console.log('node scripts/capture.mjs "<complete Tmall item URL>" ["<output root>"]');
  console.log('node scripts/capture.mjs --copy-only <itemId> ["<output root>"]');
  console.log('node scripts/capture.mjs --resume-existing <itemId> ["<output root>"]');
  console.log('node scripts/capture.mjs --dry-run "<complete Tmall item URL>" # scan only; no Eagle or receipt writes');
  console.log('node scripts/capture.mjs --self-test');
  process.exit(args[0] === '--help' ? 0 : 2);
}
if (args[0] === '--copy-only') {
  const id = args[1];
  if (!/^[0-9]{8,16}$/.test(id || '')) throw Error('Need product ID');
  acquireProductLock(root,id);
  const path = join(root, 'data', 'runs', 'stable-' + id, 'receipt.json');
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  const indexed=readRegistry(root).products[id];
  const dest=resolveOutputRoot(root,args[2]||(indexed?.outputDir?dirname(indexed.outputDir):null),config.outputRoot);
  if(indexed?.outputDir&&resolve(indexed.outputDir)!==resolve(dest,id))
    throw Error('Requested copy output differs from the recorded product outputDir');
  const copy = copyAssets(receipt, resolve(dest));
  // Exporting temporary/local copies does not change the original capture mode.
  receipt.lastExportAt=new Date().toISOString();
  Object.assign(receipt,repairCopyState(receipt,copy));
  receipt.localStatus=copy.copied===receipt.images.length&&!copy.errors.length?'complete':'incomplete';
  if(receipt.phase==='success'){ 
    try{receipt.postprocess={...receipt.postprocess,html:generateDetailPreview(join(copy.destination,'detail'),{productId:id})};}
    catch(e){receipt.postprocess={...receipt.postprocess,html:{status:'failed',error:String(e.message||e)}};}
  }
  receiptSave(path, receipt);
  await updateProduct(root,captureSummary(receipt,{outputDir:copy.destination}),{allowSuccessDowngrade:true});
  console.log(JSON.stringify({ status:receipt.phase, ...copy }, null, 2));
  process.exit(receipt.phase==='success' ? 0 : 2);
}
const dryRun = args[0] === '--dry-run';
const resumeExisting = args[0] === '--resume-existing';
if (resumeExisting && !/^[0-9]{8,16}$/.test(args[1] || ''))
  throw Error('Resume requires a product ID');
if((dryRun&&args.length!==2)||(resumeExisting&&args.length>3)||(!dryRun&&!resumeExisting&&args.length>2))
  throw Error('Unexpected arguments; use --help');
const url = new URL(resumeExisting ? 'https://detail.tmall.com/item.htm?id=' + args[1] : (dryRun ? args[1] : args[0]));
const productId = url.searchParams.get('id');
if (url.protocol !== 'https:' || url.hostname !== 'detail.tmall.com' ||
    url.pathname !== '/item.htm' || !/^[0-9]{8,16}$/.test(productId || ''))
  throw Error('Only a valid detail.tmall.com/item.htm product URL is accepted');
if(!dryRun)acquireProductLock(root,productId);
const indexedBefore=readRegistry(root).products[productId];
const explicitRoot=resumeExisting?(args[2]||(indexedBefore?.outputDir?dirname(indexedBefore.outputDir):null)):args[1];
const destRoot=dryRun?null:resolveOutputRoot(root,explicitRoot,config.outputRoot);
if(!dryRun && indexedBefore?.status==='success')throw Error('Already completed in captures.json; do not duplicate Eagle import');
if(!dryRun&&indexedBefore?.outputDir&&resolve(indexedBefore.outputDir)!==resolve(destRoot,productId))
  throw Error('Existing registry output directory differs from requested output');
const chromeLink = chromeConnection(root, config);
const eagleUrl = process.env.EAGLE_MCP_URL || config.eagleMcpUrl;
if (!dryRun && !eagleUrl) throw Error('Eagle MCP URL missing');
const dir = join(root, 'data', 'runs', 'stable-' + productId);
const receiptPath = join(dir, 'receipt.json');
let previous = null;
if (resumeExisting) {
  if (!existsSync(receiptPath)) throw Error('No existing failed run to resume');
  previous = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (previous.productId !== productId || previous.phase !== 'incomplete_before_eagle' ||
      previous.eagle !== 'not_called' || !previous.leftPageOpen)
    throw Error('Resume blocked: Eagle may have been written, or failed page was not retained');
} else if (!dryRun && existsSync(receiptPath)) {
  throw Error('Existing stable-run receipt. Do not repeat Eagle import; inspect receipt or use --copy-only.');
}
if(!dryRun)mkdirSync(dir, { recursive:true });
const skuId = resumeExisting ? previous.skuId : (url.searchParams.get('skuId') || null);
const receipt = resumeExisting ? {
  ...previous, skuId, phase:'resuming_existing_page', images:[],errors:[],copied:0
} : {
  productId, skuId, phase:'started', eagle:'not_called', images:[],
  timings:{}, errors:[], copied:0
};
if (resumeExisting) delete receipt.debug;
const save = () => {if(!dryRun)receiptSave(receiptPath, receipt)};
const mark = label => {receipt.timings[label] = ms();save();};
save();
if(!dryRun)await updateProduct(root,captureSummary(receipt,{url:resumeExisting?(indexedBefore?.url||url.href):url.href,outputDir:resolve(destRoot,productId)}));
let proc, ownPage = null, pageWasLeftOpen = resumeExisting, seq = 1;
const pending = new Map();
const rejectAll = msg => {
  for (const p of pending.values()) { clearTimeout(p.timer);p.reject(Error(msg)); }
  pending.clear();
};
function chromeRpc(method, params = {}, timeout = 20000) {
  return new Promise((resolve,reject) => {
    const id = seq++;
    const timer = setTimeout(() => {pending.delete(id);reject(Error('Chrome RPC timeout: '+method))},timeout);
    pending.set(id,{resolve,reject,timer});
    proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
}
async function chrome(name, parameters = {}, timeout=90000) {
  const output = await chromeRpc('tools/call',{name,arguments:parameters}, timeout);
  if (output?.isError) throw Error(name + ': ' + JSON.stringify(output.content).slice(0,700));
  return (output?.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
}
function parseObject(str) {
  const left = str.indexOf('{'), right = str.lastIndexOf('}');
  if (left < 0 || right <= left) throw Error('No valid browser JSON');
  return JSON.parse(str.slice(left,right+1));
}
// Page-side scanner. Dynamic image list + adaptive waiting; no fixed document height,
// image number, or expectation of a particular network loading time.
function scanProduct() {
  return (async () => {
    const sleep = t => new Promise(ok => setTimeout(ok,t));
    const maxTimeMs = 100000; // Safety bound, NOT a fixed wait.
    const started = Date.now();
    const mainSel = 'img[class*="thumbnailPic"]';
    const detailSel = '#imageTextInfo-content .descV8-container img'; // Includes richImg and singleImage; do not prefer platform-only selector.
    const detailAnySel = '#imageTextInfo-content img, [class*="descV8"] img, #J_DivItemDesc img';
    const cdnPattern = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:alicdn\.com|taobaocdn\.com|tbcdn\.cn)\//i;
    const platformPattern = /!!600000000\d+|\/600000000\d+\//;
    const imgUrl = el => {
      const srcset = el.getAttribute('srcset') || '';
      const candidates = [
        el.getAttribute('data-original'),el.getAttribute('data-src'),
        el.getAttribute('data-ks-lazyload'),el.getAttribute('data-lazyload'),
        el.getAttribute('data-lazy'),el.getAttribute('data-img'),
        el.currentSrc,el.getAttribute('src'),el.src,
        srcset ? srcset.split(',')[0]?.trim().split(/\s+/)[0] : ''
      ].filter(Boolean);
      for (let x of candidates) {
        if (x.startsWith('//'))x='https:'+x;
        if (cdnPattern.test(x))return x;
      }
      return '';
    };
    const mainEls = () => [...document.querySelectorAll(mainSel)];
    const detailEls = () => {
      const preferred=[...document.querySelectorAll(detailSel)];
      return preferred.length ? preferred : [...document.querySelectorAll(detailAnySel)];
    };
    const detailRegion=()=>document.querySelector('#imageTextInfo-content') ||
      document.querySelector('[class*="descV8-container"]') ||
      document.querySelector('[class*="descV8"]');
    const isMerchantUrl = u => !!u && !platformPattern.test(u);
    const countReady=els=>els.filter(e=>isMerchantUrl(imgUrl(e))).length;
    const signature=els=>els.map(el=>imgUrl(el)).join('|');
    const canSee = el => {
      const r=el.getBoundingClientRect();
      return r.width>0 && r.height>0;
    };
    // Activate the explicit detail tab when it exists. Does not navigate away.
    let detailClicked=false;
    const clickDetail=()=>{
      const labels=[...document.querySelectorAll('span,a,button,[role="tab"],div')].filter(el=>
        el.children.length<3 && (el.textContent||'').trim()==='图文详情' && canSee(el));
      const button=labels.find(el=>el.matches('button,a,[role="tab"]')) ||
        labels.map(el=>el.closest('button,a,[role="tab"],[class*="tab"],[class*="Tab"]')||el)
          .find(canSee);
      if(button){button.click();detailClicked=true;return true;}
      return false;
    };
    if (countReady(detailEls())===0) {
      clickDetail();
      await sleep(500);
    }
    let area=detailRegion();
    if (area) {
      area.scrollIntoView({block:'start',behavior:'instant'});
      await sleep(450);
    }
    let position=0,stable=0,tailPass=0,lastSig='',lastHeight=0;
    let lastProgress=Date.now(),peakReady=0,peakNodes=0,scrollMoves=0;
    const unresolvedImageIndices=[];
    const totalTime=()=>Date.now()-started;
    // Iterate image DOM nodes dynamically. A new item appended by lazy loading gets visited.
    while(totalTime()<maxTimeMs) {
      const imgs=detailEls();
      if (imgs.length > peakNodes || countReady(imgs) > peakReady) {
        peakNodes=Math.max(peakNodes,imgs.length);
        peakReady=Math.max(peakReady,countReady(imgs));
        lastProgress=Date.now();
      }
      if(position<imgs.length){
        const el=imgs[position];
        el.scrollIntoView({block:'center',behavior:'instant'});
        scrollMoves++;
        await sleep(280);
        if(!imgUrl(el)){
          // A slow network may need multiple polls; do not race straight past the image.
          const localUntil=Date.now()+3500;
          while(Date.now()<localUntil && Date.now()-started<maxTimeMs && !imgUrl(el)){
            await sleep(350);
          }
        }else{
          // Even with a usable URL, allow the next lazy element to mount.
          await sleep(90);
        }
        // Visiting another image is progress; reserve the idle window for tail checks.
        lastProgress=Date.now();
        position++;
        continue;
      }
      area=detailRegion();
      if(area && area.lastElementChild){
        area.lastElementChild.scrollIntoView({block:'end',behavior:'instant'});
        scrollMoves++;
      }
      await sleep(520);
      const now=detailEls();
      const height=detailRegion()?.scrollHeight||document.scrollingElement?.scrollHeight||document.documentElement.scrollHeight;
      const sig=signature(now);
      const ready=countReady(now);
      const pending=now.map((el,i)=>!imgUrl(el)?i:null).filter(x=>x!==null);
      if(now.length>position){position=Math.min(position,now.length-1);stable=0;continue;}
      if(sig===lastSig && height===lastHeight && pending.length===0 && ready>0)stable++;
      else stable=0;
      lastSig=sig;lastHeight=height;tailPass++;
      if(stable>=2)break;
      if(pending.length){
        // Revisit missing items, not the entire web page. Respect a finite idle deadline.
        if(Date.now()-lastProgress>14000)break;
        position=pending[0];
      } else if(ready===0 && !detailClicked && tailPass>=2){
        clickDetail();detailClicked=true;position=0;await sleep(550);
      } else if(Date.now()-lastProgress>14000)break;
    }
    const main=mainEls().map(el=>({url:imgUrl(el),width:el.naturalWidth,height:el.naturalHeight}));
    const detail=detailEls().map(el=>({url:imgUrl(el),width:el.naturalWidth,height:el.naturalHeight}));
    for(let i=0;i<detail.length;i++)if(!detail[i].url)unresolvedImageIndices.push(i+1);
    const platformDetail=detail.filter(d=>platformPattern.test(d.url)).length;
    const merchantDetail=detail.filter(d=>isMerchantUrl(d.url)).length;
    const debug=merchantDetail>0 && unresolvedImageIndices.length===0 ? null : {
      detailRegionFound:!!detailRegion(),detailClicked,
      imgAttributes:detailEls().slice(0,20).map(el=>({
        className:el.className,html:el.outerHTML.slice(0,500),
        visible:canSee(el),naturalWidth:el.naturalWidth
      })),
      iframeCount:document.querySelectorAll('iframe').length,
      pageTitle:document.title
    };
    return {
      host:location.host,url:location.href,title:document.title,
      login:!!document.querySelector('input[type="password"]'),
      accessAbnormal:/访问异常提示|系统检测到当前访问存在异常/.test(document.body?.innerText||''),
      captcha:!!document.querySelector('[id*="captcha"],iframe[src*="captcha"],[class*="captcha"]'),
      main,detail,metrics:{
        scanMs:totalTime(),scrollMoves,detailNodes:detail.length,
        merchantDetail,platformDetail,unresolvedImageIndices,
        stableAtTail:stable>=2,peakNodes,peakReady
      },debug
    };
  })();
}
let selection=[],page;
try {
  proc=spawn(process.execPath,chromeLink.args,
    {windowsHide:true,env:{...process.env,CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS:'1'}});
  proc.on('error',e=>rejectAll('Chrome spawn: '+e.message));
  proc.on('exit',()=>rejectAll('Chrome MCP process exited'));
  createInterface({input:proc.stdout}).on('line',line=>{
    let msg;try{msg=JSON.parse(line)}catch{return}
    const p=pending.get(msg.id);if(!p)return;
    pending.delete(msg.id);clearTimeout(p.timer);
    msg.error?p.reject(Error(JSON.stringify(msg.error))):p.resolve(msg.result);
  });
  await chromeRpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},
    clientInfo:{name:'ecom-stable-capture',version:'1.0'}},16000);
  proc.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  mark('chromeConnected');
  if (resumeExisting) {
    const list = await chrome('list_pages',{},25000);
    const matches = [...list.matchAll(/^\s*(\d+):\s*([^\r\n]+)/gm)].filter(p=>{
      const m=p[2].match(/https:\/\/detail\.tmall\.com\/item\.htm[^\s\]]+/);
      if(!m)return false;
      try{return new URL(m[0]).searchParams.get('id')===productId}catch{return false}
    });
    if(matches.length!==1)throw Error('Cannot safely identify retained product tab: matches='+matches.length);
    ownPage=Number(matches[0][1]);
    receipt.leftPageOpen=true;
    mark('existingPageReused');
  } else {
    // Always navigate using the user's complete original URL. Do not strip campaign parameters.
    const opened=await chrome('new_page',{url:url.href},90000);
    const match=opened.match(/(?:^|\n)\s*(\d+):[^\n]*\[selected\]/);
    if(!match)throw Error('Cannot identify newly opened Chrome page; do not close unknown tab');
    ownPage=Number(match[1]);mark('pageOpened');
  }
  page=parseObject(await chrome('evaluate_script',{pageId:ownPage,function:scanProduct.toString()},150000));
  mark('pageScanned');
  receipt.title=page.title;
  receipt.scan=page.metrics;
  if(page.accessAbnormal)throw Error('Tmall access abnormal; keep the product tab; use the complete original URL to inspect');
  if(page.host!=='detail.tmall.com' || page.login || page.captcha)
    throw Error('Unexpected domain, login prompt or captcha');
  const mains=unique(page.main,'main');
  const details=unique(page.detail,'detail');
  // Image counts vary per product. A page with unresolved detail images is NOT complete.
  if(!mains.length || !details.length ||
     page.metrics.unresolvedImageIndices.length || !page.metrics.stableAtTail) {
    receipt.debug=page.debug||{unresolvedImageIndices:page.metrics.unresolvedImageIndices};
    throw Error('Main/detail images incomplete: main='+mains.length+' detail='+details.length+
      ' unresolved='+page.metrics.unresolvedImageIndices.length+' tailStable='+page.metrics.stableAtTail);
  }
  selection=[...mains,...details];
  receipt.phase='selection_ready';receipt.selected={main:mains.length,detail:details.length};
  receipt.images=selection.map(x=>({category:x.category,order:x.order,url:x.url,
    name:'Tmall-'+productId+'-'+x.category+'-'+String(x.order).padStart(3,'0')}));
  mark('selectionReady');
}catch(e) {
  receipt.errors.push('Chrome: '+String(e?.message||e).slice(0,750));
  receipt.phase='incomplete_before_eagle';
  // Keep the owned diagnostic tab open after incomplete scanning instead of reopening it.
  if(ownPage!==null){receipt.leftPageOpen=true;pageWasLeftOpen=true;}
  save();
}finally {
  if(ownPage!==null && !pageWasLeftOpen){
    try{await chrome('close_page',{pageId:ownPage},16000)}catch(e){receipt.errors.push('Close own page: '+e.message)}
  }
  if(proc){try{proc.stdin.end();proc.kill()}catch{}}
}
if(!selection.length) {
  receipt.totalMs=ms();save();
  if(!dryRun)await updateProduct(root,captureSummary(receipt,{url:resumeExisting?(indexedBefore?.url||url.href):url.href,outputDir:resolve(destRoot,productId)}));
  console.log(JSON.stringify({status:receipt.phase,productId,scan:receipt.scan,
    error:receipt.errors[0],pageKeptOpen:pageWasLeftOpen,receipt:receiptPath,totalMs:ms()},null,2));
  process.exit(2);
}
if(dryRun){
  console.log(JSON.stringify({status:'dry_run_complete',productId,title:receipt.title,
    main:receipt.selected.main,detail:receipt.selected.detail,
    scan:receipt.scan,eagle:'not_called',receiptModified:false,totalMs:ms()},null,2));
  process.exit(0);
}
const canonical='https://detail.tmall.com/item.htm?id='+productId+(skuId?'&skuId='+skuId:'');
async function eagleRpc(name, params={}, limit=30000){
  const response=await fetch(eagleUrl,{
    method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0',id:Math.floor(Math.random()*1000000)+1000,
      method:'tools/call',params:{name,arguments:params}}),
    signal:AbortSignal.timeout(limit)});
  if(!response.ok)throw Error('Eagle HTTP '+response.status);
  const raw=await response.text(),line=raw.split(/\r?\n/).find(v=>v.startsWith('data:'));
  const rpc=JSON.parse(line?line.slice(5).trim():raw);
  if(rpc.error||rpc.result?.isError)throw Error('Eagle MCP '+JSON.stringify(rpc.error||rpc.result).slice(0,500));
  const body=rpc.result?.content?.find(x=>x.type==='text')?.text||'{}';
  const payload=JSON.parse(body);
  if(payload.success===false)throw Error('Eagle '+name+' '+body.slice(0,400));
  return payload.data??payload;
}
try {
  // This is a non-idempotent operation. Persist "may have submitted" BEFORE the call.
  receipt.phase='eagle_outcome_uncertain';
  receipt.eagle='may_have_submitted';
  mark('beforeEagleSubmit');
  await updateProduct(root,captureSummary(receipt,{url:canonical,outputDir:resolve(destRoot,productId)}));
  const items=receipt.images.map(x=>({source:{type:'url',url:x.url,website:canonical},name:x.name}));
  const results=await eagleRpc('item_add',{items},180000);
  const added=Array.isArray(results)?results:(results.items||[]);
  // Save only the returned IDs before querying full details. Never associate by array index.
  const ids=[...new Set(added.map(x=>x?.itemId||x?.id).filter(Boolean))];
  receipt.eagleReturnedItemIds=ids;
  mark('eagleSubmitted');
  const matched=await verifyEagleReadback(receipt.images,added,
    async itemIds=>eagleRpc('item_get',{ids:itemIds,fullDetails:true},60000));
  receipt.eagleReadbackAttempts=matched.attempts;
  receipt.images=matched.records;
  // Eagle can acknowledge an itemId while leaving a non-existent .info file.
  // Verify physical material, not just index metadata, before accepting success.
  const invalidFiles=[];
  for(const record of receipt.images.filter(x=>x.verified)){
    let material=false;
    try{const s=statSync(record.filePath);material=s.isFile()&&s.size>0}catch{}
    if(!material){
      record.verified=false;
      record.materialStatus='missing_physical_file';
      invalidFiles.push('Eagle material missing: '+record.name);
    }
  }
  receipt.errors.push(...matched.issues.map(x=>'Eagle mapping: '+x),...invalidFiles);
  mark('eagleReadback');
  receipt.eagle=receipt.images.every(x=>x.verified)&&!matched.issues.length&&!invalidFiles.length?'verified':'partially_verified';
}catch(e){
  receipt.errors.push('Eagle: '+String(e?.message||e));
  receipt.eagle='uncertain_no_retry';
}
const storageMode=storageModeFromConfig(config);
receipt.storageMode=storageMode;
receipt.phase=storageMode==='copy'?'copying':'eagle_only';
save();
let copies;
if(storageMode==='copy'){
  copies=copyAssets(receipt,destRoot);
  Object.assign(receipt,repairCopyState(receipt,copies));
  receipt.localStatus=copies.copied===receipt.images.length&&!copies.errors.length?'complete':'incomplete';
  if(receipt.phase==='success'){
    try{receipt.postprocess={...receipt.postprocess,html:generateDetailPreview(join(copies.destination,'detail'),{productId})};}
    catch(e){receipt.postprocess={...receipt.postprocess,html:{status:'failed',error:String(e.message||e)}};}
  }
}else{
  Object.assign(receipt,eagleOnlyReceiptState(receipt,destRoot));
  copies={copied:0,errors:[],destination:receipt.destination};
}
// Classification is an independent, readback-verified stage. Never repeat item_add.
try {
  receipt.archive = await archiveEagleProduct({
    rpc: (name, params) => eagleArchiveRpc(eagleUrl, name, params),
    productId, images: receipt.images,
    rootName: config.eagleArchiveRootName || archiveRootForDate(), apply: true
  });
} catch (error) {
  receipt.archive = {status:'needs_read_only_review', rootName:config.eagleArchiveRootName || archiveRootForDate(),
    error:String(error?.message||error)};
}
receipt.totalMs=ms();
save();
await updateProduct(root,captureSummary(receipt,{url:canonical,outputDir:copies.destination}));
console.log(JSON.stringify({
  status:receipt.phase,workflowStatus:receipt.phase==='success'&&receipt.archive?.status==='complete'?'complete':'incomplete',productId,title:receipt.title,
  main:receipt.selected.main,detail:receipt.selected.detail,
  submitted:selection.length,verified:receipt.images.filter(x=>x.verified).length,
  copied:copies.copied,destination:copies.destination,totalMs:ms(),
  eagleReadbackAttempts:receipt.eagleReadbackAttempts||0,
  html:receipt.postprocess?.html||{status:'skipped'},
  archive:receipt.archive,
  timings:receipt.timings,errors:receipt.errors
},null,2));
if(receipt.phase!=='success'||receipt.archive?.status!=='complete')process.exitCode=2;
