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
import {generateDetailPreview} from './html-preview.mjs';
import {archiveEagleProduct, ensureEagleProductFolders, ECOM_ARCHIVE_ROOT, eagleArchiveRpc} from './eagle-archive.mjs';
import {storageModeFromConfig, eagleOnlyReceiptState} from './storage-mode.mjs';
import {stitchEagleProduct} from './stitch-eagle-core.mjs';
import {importEagleInBatches} from './eagle-batch.mjs';
import {evaluateInNavigatedTab} from './chrome-navigation.mjs';
import {sourceCandidates} from './eagle-source-index.mjs';
import {resolveReusedSlots,associateConfirmedReuse} from './eagle-reuse-resolution.mjs';
import {listFolderItems,hashEagleFile,readCurrentEagleProduct} from './eagle-current.mjs';
import {makeMap,saveMap} from './eagle-product-map.mjs';
import {mirrorEagleMap} from './eagle-map-mirror.mjs';
import {processV3ImportedImages,eagleV2GetById} from './v3-eagle-import.mjs';
import {visibleEagleItemCount,syncV3StitchPartsToIndex} from './v3-fingerprint.mjs';
import {createV3ReadbackRpc} from './v3-web-readback.mjs';
import {syncIndustryAfterProductComplete} from './industry-eagle.mjs';
import {classifyProductTitle,isConfidentClassification} from './industry-core.mjs';
import {assertIndustryMigrationNotActive} from './eagle-industry-move.mjs';

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
const v3Capture = args[0] === '--v3';
if(v3Capture&&config.v3Experimental!==true)
  throw Error('V3.1 experimental capture is disabled by default; set v3Experimental=true only for an authorized trial');
if (resumeExisting && !/^[0-9]{8,16}$/.test(args[1] || ''))
  throw Error('Resume requires a product ID');
if((dryRun&&args.length!==2)||(resumeExisting&&args.length>3)||(v3Capture&&(args.length<2||args.length>3))||(!dryRun&&!resumeExisting&&!v3Capture&&args.length>2))
  throw Error('Unexpected arguments; use --help');
const url = new URL(resumeExisting ? 'https://detail.tmall.com/item.htm?id=' + args[1] : ((dryRun||v3Capture) ? args[1] : args[0]));
const productId = url.searchParams.get('id');
if (url.protocol !== 'https:' || url.hostname !== 'detail.tmall.com' ||
    url.pathname !== '/item.htm' || !/^[0-9]{8,16}$/.test(productId || ''))
  throw Error('Only a valid detail.tmall.com/item.htm product URL is accepted');
if(!dryRun){assertIndustryMigrationNotActive(root);acquireProductLock(root,productId);}
const indexedBefore=readRegistry(root).products[productId];
const explicitRoot=resumeExisting?(args[2]||(indexedBefore?.outputDir?dirname(indexedBefore.outputDir):null)):(v3Capture?args[2]:args[1]);
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
  ...(v3Capture?{captureVersion:'v3.1-experimental'}:{}),
  timings:{}, errors:[], copied:0
};
receipt.autoStitchEnabled = config.autoStitch !== false;
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
    // Valid external certification images are informational, not Tmall merchant CDN assets.
    const certificatePattern = /^https:\/\/oss\.gds\.org\.cn\/userfile2\/Product\/Voucher\/Images\//i;
    const isCertificationImage = el => [el.currentSrc,el.getAttribute('src'),el.src]
      .filter(Boolean).some(x=>certificatePattern.test(x));
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
      const pending=now.map((el,i)=>!imgUrl(el)&&!isCertificationImage(el)?i:null).filter(x=>x!==null);
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
    const finalDetailEls=detailEls();
    for(let i=0;i<detail.length;i++)if(!detail[i].url&&!isCertificationImage(finalDetailEls[i]))unresolvedImageIndices.push(i+1);
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
        merchantDetail,platformDetail,excludedCertification:finalDetailEls.filter(isCertificationImage).length,unresolvedImageIndices,
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
  page=parseObject(await evaluateInNavigatedTab(
    ()=>chrome('evaluate_script',{pageId:ownPage,function:scanProduct.toString()},150000),
    {onRetry:attempt=>{receipt.navigationRaceRetries=attempt;save();}}
   ));
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
assertIndustryMigrationNotActive(root);
const effectiveIndustryClassification=indexedBefore?.classification?.manualLocked
  ?indexedBefore.classification:classifyProductTitle(receipt.title);
const effectiveIndustryCode=isConfidentClassification(effectiveIndustryClassification)
  ?effectiveIndustryClassification.industryCode:null;
let v3ReadbackRpc=null;
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
  if(v3Capture){
    receipt.phase='v3_prefetch_and_import';
    const indexPath=join(root,'data','fingerprints','v3-eagle.sqlite');
    if(!existsSync(indexPath))throw Error('V3 fingerprint index missing; run v3-index --build');
    const app=await eagleRpc('get_app_info',{},45000);
    if(!app?.libraryPath)throw Error('Active Eagle library path missing');
    const folders=await ensureEagleProductFolders({
      rpc:(name,params)=>eagleRpc(name,params,45000),productId,
      rootName:config.eagleArchiveRootName||ECOM_ARCHIVE_ROOT,
      industryCode:effectiveIndustryCode,apply:true});
    receipt.folderIds=folders;save();
    const imported=await processV3ImportedImages({
      root,productId,url:canonical,images:receipt.images,libraryPath:app.libraryPath,
      folderIds:folders,indexPath,
      linkFolders:(ids,fids)=>eagleRpc('item_add_to_folders',{ids,folders:fids},60000),
      checkLibrary:async()=>visibleEagleItemCount()
    });
    receipt.images=imported.images;
    receipt.eagle='verified';
    receipt.eagleBatches=[];
    receipt.v3Job={status:imported.status,verified:imported.images.length};
    v3ReadbackRpc=createV3ReadbackRpc({eagleMcpUrl:eagleUrl,libraryPath:app.libraryPath});
    mark('eagleReadback');
  }else{
  receipt.phase='eagle_outcome_uncertain';
  receipt.eagle='may_have_submitted';
  mark('beforeEagleSubmit');
  await updateProduct(root,captureSummary(receipt,{url:canonical,outputDir:resolve(destRoot,productId)}));
  // Journal each small batch before calling Eagle's non-idempotent item_add.
  receipt.eagleBatches=[];
  const sourceIndex=sourceCandidates(root,{excludeProductId:productId});
  const archiveRoot=config.eagleArchiveRootName||ECOM_ARCHIVE_ROOT;
  const scopedRpc=(name,params)=>eagleRpc(name,params,45000);
  const folders=await ensureEagleProductFolders({rpc:scopedRpc,productId,
    rootName:archiveRoot,industryCode:effectiveIndustryCode,apply:true});
  if(!folders)throw Error('Cannot verify Eagle category folders before import');
  receipt.folderIds=folders;save();
  const planned=receipt.images.map(x=>({...x,website:canonical}));
  const batchResult=await importEagleInBatches(planned,{
    add:items=>eagleRpc('item_add',{items},180000),
    read:ids=>eagleRpc('item_get',{ids,fullDetails:true},60000),
    exists:path=>{try{const s=statSync(path);return s.isFile()&&s.size>0}catch{return false}},
    batchSize:8,folderIds:folders,
    resolveReused:async ({group,submitted,records,unverified,batchIndex})=>{
      if(!unverified.length){
        for(const x of records.filter(x=>x.verified)){
          const ids=sourceIndex.get(x.url)||[];
          if(x.itemId&&!ids.includes(x.itemId))sourceIndex.set(x.url,[...ids,x.itemId]);
        }
        return {resolved:[],unresolved:[]};
      }
      const [main,detail]=await Promise.all([
        listFolderItems(scopedRpc,folders.main),listFolderItems(scopedRpc,folders.detail)
      ]);
      const candidates=[...main.filter(x=>x.folders?.includes(folders.main)).map(x=>({...x,category:'main'})),
        ...detail.filter(x=>x.folders?.includes(folders.detail)).map(x=>({...x,category:'detail'}))];
      const resolved=await resolveReusedSlots({missing:unverified,candidates,
        knownSources:sourceIndex,inspect:hashEagleFile});
      const hard=new Set(resolved.unresolved.filter(x=>
        ['fallback_hash_mismatch','fallback_metadata_invalid','ambiguous_shared_items'].includes(x.reason))
        .map(x=>x.name));
      const remaining=unverified.filter(x=>
        resolved.unresolved.some(r=>r.name===x.name)&&!hard.has(x.name));
      const linked=remaining.length?await associateConfirmedReuse({
        missing:remaining,submitted,knownSources:sourceIndex,folderIds:folders,
        readByIds:ids=>eagleRpc('item_get',{ids,fullDetails:true},60000),
        inspect:hashEagleFile,
        linkToFolder:(ids,folderIds)=>eagleRpc('item_add_to_folders',{ids,folders:folderIds},60000),
        journal:async step=>{
          const batch=receipt.eagleBatches[batchIndex-1];
          batch.associations=[...(batch.associations||[]).filter(x=>x.name!==step.name),step];
          save();
        }
      }):{resolved:[],unresolved:[]};
      resolved.resolved.push(...linked.resolved);
      resolved.unresolved=[...resolved.unresolved.filter(x=>
        hard.has(x.name)),...linked.unresolved];
      for(const x of [...records.filter(x=>x.verified),...resolved.resolved]){
        const known=sourceIndex.get(x.url)||[];
        if(x.itemId&&!known.includes(x.itemId))sourceIndex.set(x.url,[...known,x.itemId]);
      }
      return resolved;
    },
    record:async batch=>{
      receipt.eagleBatches[batch.index-1]=batch;
      receipt.eagleReturnedItemIds=[...new Set(receipt.eagleBatches.flatMap(x=>x?.ids||[]))];
      save();
    }
  });
  receipt.eagleReadbackAttempts=batchResult.readbackAttempts;
  receipt.images=batchResult.records;
  receipt.errors.push(...batchResult.issues);
  mark('eagleReadback');
  receipt.eagle=receipt.images.length===selection.length&&receipt.images.every(x=>x.verified)&&
    !batchResult.issues.length?'verified':'partially_verified';
  } // Legacy V2 import remains the default.
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
    rpc: (name, params) => v3ReadbackRpc ? v3ReadbackRpc(name,params) : eagleArchiveRpc(eagleUrl, name, params),
    productId, images: receipt.images,
    rootName: config.eagleArchiveRootName || ECOM_ARCHIVE_ROOT,
    industryCode:effectiveIndustryCode,apply: true
  });
} catch (error) {
  receipt.archive = {status:'needs_read_only_review', rootName:config.eagleArchiveRootName || ECOM_ARCHIVE_ROOT,
    error:String(error?.message||error)};
}
receipt.totalMs=ms();
save();
// Persist a per-library product-position map, then mirror only a COMPLETE map
// to Eagle folder descriptions. Never infer success from item_add IDs alone.
try{
  const checkedIds=[...new Set(receipt.images.filter(x=>x.verified&&x.itemId).map(x=>x.itemId))];
  const actual=new Map();
  for(let i=0;i<checkedIds.length;i+=100){
    const response=await (v3ReadbackRpc ? v3ReadbackRpc('item_get',{ids:checkedIds.slice(i,i+100),fullDetails:true}) : eagleRpc('item_get',{ids:checkedIds.slice(i,i+100),fullDetails:true},60000));
    for(const item of (Array.isArray(response)?response:response.items||[]))actual.set(item.id,item);
  }
  const cache=new Map();
  for(const image of receipt.images){
    if(!image.verified||!image.itemId)continue;
    const item=actual.get(image.itemId),fid=receipt.folderIds?.[image.category];
    if(!item||!item.folders?.includes(fid)||item.isDeleted===true){
      image.verified=false;continue;
    }
    if(!cache.has(item.id))cache.set(item.id,await hashEagleFile(item));
    const proof=cache.get(item.id);
    if(image.resolution==='reused'&&image.eagleName!==item.name)
      throw Error('Eagle reused item changed its global name');
    image.sha256=proof.sha256;
    image.filePath=proof.filePath;
    image.eagleName=item.name;
  }
  const appInfo=await eagleRpc('get_app_info',{},45000);
  const mapping=makeMap(productId,receipt.images,{libraryPath:appInfo.libraryPath||null,
    folders:{main:receipt.folderIds.main,detail:receipt.folderIds.detail}});
  const independent=await readCurrentEagleProduct({
    rpc:(name,params)=>v3ReadbackRpc ? v3ReadbackRpc(name,params) : eagleRpc(name,params,60000),
    productId,images:receipt.images,rootName:receipt.archive?.rootName||config.eagleArchiveRootName||ECOM_ARCHIVE_ROOT,
    productMap:mapping
  });
  if(independent.status!==mapping.status||independent.invalid.length)
    throw Error('Product mapping conflicts with independent Eagle verification');
  const saved=saveMap(root,mapping);
  receipt.productMap={status:mapping.status,path:saved.path,sourceMode:'product_map'};
  if(mapping.status==='complete'&&receipt.archive?.status==='complete'){
    const mirror=await mirrorEagleMap({
      rpc:(name,params)=>v3ReadbackRpc ? v3ReadbackRpc(name,params) : eagleRpc(name,params,60000),map:mapping,apply:true});
    receipt.productMap.mirrorStatus=mirror.status;
  }else receipt.productMap.mirrorStatus='blocked_incomplete';
}catch(e){
  receipt.productMap={status:'needs_read_only_review',error:String(e.message||e)};
  receipt.errors.push('Product mapping: '+String(e.message||e));
}
save();
// Automatically stitch only after source files and Eagle classification are complete.
if(receipt.autoStitchEnabled){
  if(receipt.archive?.status==='complete' && receipt.eagle==='verified'){
    if(!process.env.STITCH_FFMPEG&&config.ffmpegExecutablePath)
      process.env.STITCH_FFMPEG=config.ffmpegExecutablePath;
    if(!process.env.STITCH_FFPROBE&&config.ffprobeExecutablePath)
      process.env.STITCH_FFPROBE=config.ffprobeExecutablePath;
    try{
      receipt.postprocess={...receipt.postprocess,stitch:await stitchEagleProduct({
        rpc:(name,params)=>v3ReadbackRpc ? v3ReadbackRpc(name,params) : eagleArchiveRpc(eagleUrl,name,params,name==='item_add'?90000:45000),
        productId,images:receipt.images,rootName:receipt.archive.rootName,width:750,apply:true,
        outputRoot:join(root,'data','stitch-eagle')
      })};
      if(v3Capture&&receipt.postprocess.stitch?.status==='complete'){
        try{
          const currentApp=await eagleRpc('get_app_info',{});
          receipt.postprocess.indexSync=await syncV3StitchPartsToIndex({
            indexPath:join(root,'data','fingerprints','v3-eagle.sqlite'),
            libraryPath:currentApp.libraryPath,parts:receipt.postprocess.stitch.parts,
            getById:eagleV2GetById,getLiveCount:visibleEagleItemCount
          });
        }catch(indexError){
          receipt.postprocess.indexSync={status:'needs_read_only_review',
            error:String(indexError.message||indexError)};
        }
      }
    }catch(e){
      receipt.postprocess={...receipt.postprocess,stitch:{status:'needs_read_only_review',error:String(e.message||e)}};
    }
  }else receipt.postprocess={...receipt.postprocess,stitch:{status:'blocked_incomplete_eagle_sources'}};
}
receipt.totalMs=ms();save();
await updateProduct(root,captureSummary(receipt,{url:canonical,outputDir:copies.destination}));
console.log(JSON.stringify({
  industrySync:await syncIndustryAfterProductComplete(root,productId),
  status:receipt.phase,workflowStatus:receipt.phase==='success'&&receipt.archive?.status==='complete'&&
    (!receipt.autoStitchEnabled||['complete','already_complete'].includes(receipt.postprocess?.stitch?.status))&&
     (!receipt.productMap||receipt.productMap.status==='complete'&&receipt.productMap.mirrorStatus==='complete')?'complete':'incomplete',productId,title:receipt.title,
  main:receipt.selected.main,detail:receipt.selected.detail,
  submitted:selection.length,verified:receipt.images.filter(x=>x.verified).length,
  copied:copies.copied,destination:copies.destination,totalMs:ms(),
  eagleReadbackAttempts:receipt.eagleReadbackAttempts||0,
  html:receipt.postprocess?.html||{status:'skipped'},
  stitch:receipt.postprocess?.stitch||{status:'skipped'},
  archive:receipt.archive,
  productMap:receipt.productMap||{status:'legacy'},
  timings:receipt.timings,errors:receipt.errors
},null,2));
if(receipt.phase!=='success'||receipt.archive?.status!=='complete'||
  (receipt.autoStitchEnabled&&!['complete','already_complete'].includes(receipt.postprocess?.stitch?.status))||
  (receipt.productMap&&!(receipt.productMap.status==='complete'&&receipt.productMap.mirrorStatus==='complete')))process.exitCode=2;
