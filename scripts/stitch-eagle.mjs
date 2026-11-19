#!/usr/bin/env node
// Agent entrypoint: read original classified Eagle files -> stitch -> import only
// finished JPEG parts to the product root. --check never writes to Eagle.
import {readFileSync,existsSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireProductLock} from './capture-store.mjs';
import {eagleArchiveRpc} from './eagle-archive.mjs';
import {stitchEagleProduct} from './stitch-eagle-core.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const argv=process.argv.slice(2);
const productId=argv.shift();
const checkOnly=argv.includes('--check');
const rest=argv.filter(x=>x!=='--check');
const targetWidth=rest[0]&&/^[0-9]{2,4}$/.test(rest[0])?Number(rest.shift()):null;
const date=rest.length===2&&rest[0]==='--date'?rest[1]:null;
if(!/^[0-9]{8,16}$/.test(productId||'')||rest.length&&!(rest.length===2&&date&&/^\d{4}-\d{2}-\d{2}$/.test(date))||
   targetWidth!==null&&(targetWidth<32||targetWidth>8192)){
  console.error(JSON.stringify({status:'invalid_arguments',usage:'stitch-eagle <productId> [width] [--date YYYY-MM-DD] [--check]'}));
  process.exit(2);
}
const receiptFile=join(root,'data','runs','stable-'+productId,'receipt.json');
if(!existsSync(receiptFile))throw Error('No expected product receipt: '+productId);
const receipt=JSON.parse(readFileSync(receiptFile,'utf8'));
if(receipt.productId!==productId||!Array.isArray(receipt.images))throw Error('Invalid product receipt');
const config=(name)=>{
  const path=join(root,'config',name);
  return existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
};
const cfg={...config('local.example.json'),...config('local.json')};
const endpoint=process.env.EAGLE_MCP_URL||cfg.eagleMcpUrl;
if(!endpoint)throw Error('Missing Eagle MCP URL');
if(!process.env.STITCH_FFMPEG&&cfg.ffmpegExecutablePath)
  process.env.STITCH_FFMPEG=cfg.ffmpegExecutablePath;
if(!process.env.STITCH_FFPROBE&&cfg.ffprobeExecutablePath)
  process.env.STITCH_FFPROBE=cfg.ffprobeExecutablePath;
let unlock;
try{
  if(!checkOnly)unlock=acquireProductLock(root,productId);
  const result=await stitchEagleProduct({
    rpc:(name,args)=>eagleArchiveRpc(endpoint,name,args,name==='item_add'?90000:45000),
    productId,images:receipt.images,
    rootName:date?'天猫批量采集_'+date:receipt.archive?.rootName||null,
    width:targetWidth,apply:!checkOnly,
    outputRoot:join(root,'data','stitch-eagle')
  });
  console.log(JSON.stringify({operation:'stitch-eagle',...result},null,2));
  if(!['ready','complete','already_complete'].includes(result.status))process.exitCode=2;
}catch(e){
  console.error(JSON.stringify({operation:'stitch-eagle',status:'needs_read_only_review',
    error:String(e.message||e),noAutomaticRetry:true},null,2));
  process.exitCode=2;
}finally{unlock?.()}
