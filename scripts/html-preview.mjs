#!/usr/bin/env node
// Generate an offline, source-preserving detail preview. Never downloads or stitches images.
import {readdirSync,readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const marker='<!-- ecom-image-capture:generated-preview:v1 -->';
const escapeHtml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function generateDetailPreview(detailDir,{productId,force=false,checkOnly=false}={}){
  const dir=resolve(detailDir);
  if(!existsSync(dir))throw Error('Detail image directory does not exist: '+dir);
  const images=readdirSync(dir).map(name=>{
    const match=name.match(/^(\d{1,4})\.(jpg|jpeg|png|gif|webp)$/i);
    return match?{name,number:Number(match[1])}:null;
  }).filter(Boolean).sort((a,b)=>a.number-b.number);
  if(!images.length)throw Error('No numbered detail images: '+dir);
  for(let i=0;i<images.length;i++){
    if(images[i].number!==i+1)throw Error('Missing/duplicate detail sequence at '+(i+1));
    if(!statSync(join(dir,images[i].name)).size)throw Error('Empty detail image: '+images[i].name);
  }
  const id=productId||'商品';
  const imgs=images.map((x,i)=>
    '      <figure><img src="./'+encodeURIComponent(x.name)+'" alt="详情图 '+String(i+1).padStart(2,'0')+'" loading="'+(i<2?'eager':'lazy')+'" decoding="async"></figure>'
  ).join('\n');
  const html=`<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${escapeHtml(id)}｜详情页连续预览</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#eef0f3;color:#283041;font-family:"Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif}
.page{width:min(750px,100%);margin:0 auto;background:#fff;box-shadow:0 8px 36px #1c263013}
.intro{padding:16px 20px;line-height:1.5}.intro h1{margin:0;font-size:16px}.intro p{margin:4px 0 0;color:#687184;font-size:12px}
figure{margin:0;padding:0;line-height:0}.images img{display:block;width:100%;height:auto;border:0}
.end{padding:18px;color:#8c95a4;text-align:center;font-size:12px}
@media print{body{background:#fff}.page{box-shadow:none}figure{break-inside:avoid}}
</style></head>
<body>
<main class="page">
<header class="intro"><h1>商品 ${escapeHtml(id)} · 详情页预览</h1>
<p>共 ${images.length} 张 · 按文件顺序连续展示 · GIF 保留动画 · 本地离线浏览</p></header>
<section class="images" aria-label="商品详情图连续浏览">
${imgs}
</section><footer class="end">全部 ${images.length} 张详情图已展示 · 原图未拼接、未修改</footer>
</main>
</body></html>
${marker}
`;
  const path=join(dir,'HTML.html');
  if(existsSync(path)){
    const old=readFileSync(path,'utf8');
    if(old===html)return {status:'unchanged',path,images:images.length};
    if(!old.includes(marker)&&!force)throw Error('Existing hand-edited HTML.html; explicit --force required');
    if(checkOnly)return {status:'needs_update',path,images:images.length};
  }
  if(checkOnly)return {status:'missing',path,images:images.length};
  writeFileSync(path,html,{encoding:'utf8',flag:existsSync(path)?'w':'wx'});
  return {status:'generated',path,images:images.length};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),force=args.includes('--force');
  let dir,id;
  if(args[0]==='--product'&&/^\d{8,16}$/.test(args[1]||'')){
    id=args[1];
    const {readRegistry}=await import('./capture-store.mjs');
    const record=readRegistry(root).products[id];
    if(!record?.outputDir)throw Error('Product has no recorded outputDir: '+id);
    dir=join(record.outputDir,'detail');
  }else if(args[0]==='--dir'&&args[1]){
    dir=resolve(args[1]);id=args[2]&&!args[2].startsWith('--')?args[2]:undefined;
  }else throw Error('Usage: node scripts/html-preview.mjs --product <id> [--force] OR --dir "<detail>" [id] [--force]');
  console.log(JSON.stringify(generateDetailPreview(dir,{productId:id,force}),null,2));
}
