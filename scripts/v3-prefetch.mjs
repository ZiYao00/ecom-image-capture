// V3.1 single-fetch, byte-preserving image preflight. No Eagle writes in this module.
import {readFileSync,writeFileSync,mkdirSync,existsSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';

export const V3_MAX_IMAGE_BYTES=30*1024*1024;
const CDN_RE=/^https:\/\/(?:[a-z0-9-]+\.)*(?:alicdn\.com|taobaocdn\.com|tbcdn\.cn)\//i;
export const BROWSER_IMAGE_HEADERS=Object.freeze({
  Accept:'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36'
});

export function detectImageFormat(bytes) {
  if(bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'jpg';
  if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
  if(bytes.length>=6&&['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)))return 'gif';
  if(bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'webp';
  throw Error('Unsupported or invalid image payload');
}

export function imageUrlAllowed(url) {
  try{
    const parsed=new URL(url);
    return CDN_RE.test(parsed.href)&&parsed.username===''&&parsed.password===''&&parsed.protocol==='https:';
  }catch{return false}
}

export async function fetchOriginalBytes(url,{fetchFn=fetch,headers=BROWSER_IMAGE_HEADERS,maxBytes=V3_MAX_IMAGE_BYTES}={}) {
  if(!imageUrlAllowed(url))throw Error('Image URL not in allowed HTTPS CDN');
  const response=await fetchFn(url,{headers,redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error('Image prefetch HTTP '+response.status);
  const length=Number(response.headers.get('content-length')||0);
  if(length>maxBytes)throw Error('Image exceeds prefetch limit');
  const chunks=[];let size=0;
  for await(const chunk of response.body){
    size+=chunk.byteLength;
    if(size>maxBytes)throw Error('Image exceeds prefetch limit');
    chunks.push(Buffer.from(chunk));
  }
  if(size<12)throw Error('Image payload is empty or truncated');
  const bytes=Buffer.concat(chunks,size);
  const ext=detectImageFormat(bytes);
  const sha256=createHash('sha256').update(bytes).digest('hex');
  return {bytes,ext,sha256,size,mime:response.headers.get('content-type')||null};
}

export function validateOriginalRepresentation(url,ext) {
  const original=new URL(url).pathname.toLowerCase().match(/\.(jpe?g|png|gif|webp)(?:$|_)/)?.[1];
  if(!original)return {status:'unmarked',sourceExt:null};
  const normalized=original==='jpeg'?'jpg':original;
  if(normalized!==ext)return {status:'representation_changed',sourceExt:normalized,receivedExt:ext};
  return {status:'matched',sourceExt:normalized};
}

// A CDN can negotiate WebP for a .jpg URL. Retry only the safe HTTP GET with
// progressively stricter Accept headers; never transcode or submit Eagle on mismatch.
export async function prefetchOriginalRepresentation(url,{fetchFn=fetch}={}){
  const accepted=[
    BROWSER_IMAGE_HEADERS,
    {...BROWSER_IMAGE_HEADERS,Accept:'image/png,image/jpeg;q=0.1,image/gif;q=0.1,*/*;q=0.01'},
    {...BROWSER_IMAGE_HEADERS,Accept:'image/jpeg,image/png,image/gif,image/webp;q=0.1,*/*;q=0.01'},
    {...BROWSER_IMAGE_HEADERS,Accept:'image/jpeg'}
  ];
  const seen=[];
  let last=null;
  for(const [index,headers] of accepted.entries()){
    const result=await fetchOriginalBytes(url,{fetchFn,headers});
    const representation=validateOriginalRepresentation(url,result.ext);
    const actualMime={jpg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp'}[result.ext];
    if(result.mime&&result.mime.toLowerCase().split(';')[0].trim()!==actualMime)
      throw Error('CDN response MIME conflicts with validated image bytes');
    seen.push({attempt:index+1,receivedExt:result.ext,sha256:result.sha256});
    if(representation.status!=='representation_changed')
      return {...result,representation,fetchAttempt:index+1};
    last={result,representation};
  }
  // No image conversion is performed here. Accept the server's actual image
  // only if ALL tested content-negotiation requests returned identical bytes.
  if(new Set(seen.map(x=>x.sha256)).size!==1)
    throw Error('CDN encoding differs by request; no unambiguous original representation');
  return {...last.result,representation:{status:'server_encoded_differently',
    sourceExt:last.representation.sourceExt,receivedExt:last.result.ext,
    contentConsistentAcross:accepted.length},fetchAttempt:accepted.length};
}

export function saveCacheFile(root,productId,slot,result){
  if(!/^\d{8,16}$/.test(String(productId))||!['main','detail'].includes(slot.category)||
     !Number.isInteger(slot.order)||slot.order<1||slot.order>9999||
     !/^[a-f0-9]{64}$/.test(result.sha256)||!['jpg','png','gif','webp'].includes(result.ext))
     throw Error('Invalid V3 prefetch cache identity');
  const dest=join(root,'data','v3-cache',String(productId),slot.category,
    String(slot.order).padStart(3,'0')+'-'+result.sha256.slice(0,16)+'.'+result.ext);
  mkdirSync(join(root,'data','v3-cache',String(productId),slot.category),{recursive:true});
  if(existsSync(dest)){
    const file=readFileSync(dest);
    if(file.length!==result.size||createHash('sha256').update(file).digest('hex')!==result.sha256)
      throw Error('V3 cached file content mismatch; never overwrite: '+dest);
  }else writeFileSync(dest,result.bytes,{flag:'wx'});
  if(statSync(dest).size!==result.size)throw Error('V3 cache physical write incomplete');
  return dest;
}
