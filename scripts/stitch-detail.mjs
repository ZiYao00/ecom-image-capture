#!/usr/bin/env node
// Optional detail stitching. Invoke only AFTER the user explicitly approves stitching.
// No Chrome/Eagle MCP, no Eagle writes, no edits to captures.json or receipt.json.
import {existsSync,readFileSync,statSync} from 'node:fs';
import {resolve,join,dirname,basename,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readRegistry,acquireProductLock} from './capture-store.mjs';
import {stitchImages,naturalImageFiles,IMAGE_EXTENSIONS} from './stitch-core.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
// Optional machine-local shared FFmpeg paths; explicit environment overrides take priority.
const localConfigPath=join(root,'config','local.json');
if(existsSync(localConfigPath)){
 const local=JSON.parse(readFileSync(localConfigPath,'utf8'));
 if(!process.env.STITCH_FFMPEG&&typeof local.ffmpegExecutablePath==='string')
  process.env.STITCH_FFMPEG=local.ffmpegExecutablePath;
 if(!process.env.STITCH_FFPROBE&&typeof local.ffprobeExecutablePath==='string')
  process.env.STITCH_FFPROBE=local.ffprobeExecutablePath;
}
function usage(){
  console.log('node scripts/stitch-detail.mjs --product <商品ID> [--output-dir "<新目录>"] [--width 790] [--max-height 65500]');
  console.log('node scripts/stitch-detail.mjs --dir "<商品目录或详情图目录>" [--files "01.jpg,02.png"] [--output-dir "<新目录>"]');
  console.log('在用户确认需要拼接之后才执行；采集完成不会自动运行。已有同名输出默认拒绝覆盖。');
}
function parse(argv){
  const o={product:null,dir:null,width:null,maxHeight:65500,outputDir:null,files:null};
  for(let i=0;i<argv.length;i++){
    const key=argv[i];
    if(key==='--help'){o.help=true;continue}
    if(!['--product','--dir','--width','--max-height','--output-dir','--files'].includes(key)){
      if(!key.startsWith('--')&&o.dir===null){o.dir=key;continue}
      throw Error('Unknown stitching argument '+key);
    }
    if(i+1>=argv.length)throw Error('Missing value for '+key);
    const value=argv[++i];
    if(key==='--product')o.product=value;
    else if(key==='--dir')o.dir=value;
    else if(key==='--width')o.width=Number(value);
    else if(key==='--max-height')o.maxHeight=Number(value);
    else if(key==='--output-dir')o.outputDir=resolve(value);
    else if(key==='--files')o.files=value.split(',').map(s=>s.trim()).filter(Boolean);
  }
  if(!o.help&&(!o.product&&!o.dir || o.product&&o.dir))throw Error('Provide either --product or --dir, not both');
  return o;
}
function filesForProduct(id){
  if(!/^\d{8,16}$/.test(id))throw Error('Invalid product ID');
  const product=readRegistry(root).products[id];
  if(!product||product.status!=='success'||!product.outputDir)
    throw Error('Product is absent/incomplete in captures.json: '+id);
  if(product.copiedCount!==product.mainCount+product.detailCount||product.verifiedCount!==product.copiedCount)
    throw Error('Cannot stitch: capture is not completely verified: '+id);
  const receiptPath=join(root,'data/runs/stable-'+id,'receipt.json');
  let info;
  if(existsSync(receiptPath)){
    const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));
    if(receipt.productId!==id||receipt.phase!=='success'||receipt.eagle!=='verified')
      throw Error('Product receipt not fully verified');
    info=receipt.images.filter(x=>x.category==='detail');
    if(info.some(x=>x.verified!==true))throw Error('Unverified detail receipt entry');
  }else if(id==='910333188743'){
    const receipt=JSON.parse(readFileSync(join(root,'data/runs/20261029-910333188743-R01/import-report.json'),'utf8'));
    if(String(receipt.id)!==id)throw Error('R01 record mismatch');
    info=receipt.records.filter(x=>x.category==='detail');
    if(info.some(x=>x.status!=='verifiedPresent'))throw Error('Unverified legacy detail');
  }else throw Error('Historical receipt not found: '+id);
  if(info.length!==product.detailCount||info.length<1)
    throw Error('Detail count differs from product registry');
  info.sort((a,b)=>a.order-b.order);
  if(info.some((x,i)=>x.order!==i+1))throw Error('Detail record order is missing or duplicated');
  const files=info.map(x=>{
    const ext=String(x.ext||x.savedExt||extname(x.filePath).slice(1)).toLowerCase().replace(/[^a-z0-9]/g,'');
    if(!IMAGE_EXTENSIONS.has('.'+ext))throw Error('Unsupported original detail format: '+ext);
    return join(product.outputDir,'detail',String(x.order).padStart(2,'0')+'.'+ext);
  });
  for(const path of files)if(!existsSync(path)||statSync(path).size===0)
    throw Error('Missing original image: '+path);
  return {files,defaultOutputDir:product.outputDir};
}
function filesForFolder(dir,fileNames){
  const folder=resolve(dir);
  const detail=existsSync(join(folder,'detail'))?join(folder,'detail'):folder;
  if(!existsSync(detail)||!statSync(detail).isDirectory())
    throw Error('Detail image folder not found: '+detail);
  const names=fileNames||naturalImageFiles(detail);
  if(!names.length)throw Error('No images in chosen folder');
  const files=names.map(name=>{
    const p=resolve(detail,name);
    if(!existsSync(p)||!statSync(p).isFile()||!IMAGE_EXTENSIONS.has(extname(p).toLowerCase()))
      throw Error('Invalid explicit input: '+p);
    if(/^(?:stitched|detail-long)-/i.test(basename(p)))
      throw Error('Generated long image cannot be used as source: '+p);
    return p;
  });
  const outputDir=basename(detail).toLowerCase()==='detail'?dirname(detail):folder;
  return {files,defaultOutputDir:outputDir};
}
let unlock;
try {
 const o=parse(process.argv.slice(2));
 if(o.help){usage();process.exit(0);}
 if(o.product){
   unlock=acquireProductLock(root,o.product);
 }
 const input=o.product?filesForProduct(o.product):filesForFolder(o.dir,o.files);
 const result=stitchImages({
   files:input.files,outputDir:o.outputDir||input.defaultOutputDir,
   width:o.width,maxHeight:o.maxHeight
 });
 console.log(JSON.stringify({...result,productId:o.product||null,outputDir:o.outputDir||input.defaultOutputDir},null,2));
}catch(error){
 console.error('Stitch failed: '+error.message);
 process.exitCode=2;
}finally{
 unlock?.();
}
