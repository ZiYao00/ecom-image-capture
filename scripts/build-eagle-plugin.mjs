#!/usr/bin/env node
// Build an Eagle window plugin from html3.html without network dependencies.
// The source of truth for the UI is html3.html; generated index.html stays inside eagle-plugin/.
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deflateSync} from 'node:zlib';

const root=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plugin=join(root,'eagle-plugin');
const manifest=JSON.parse(readFileSync(join(plugin,'manifest.json'),'utf8'));
const html=readFileSync(join(root,'html3.html'));
if(!html.toString('utf8').includes('chooseEagleDetailItems') || manifest.main?.url!=='index.html')
  throw Error('Eagle plugin source / manifest is not ready');
mkdirSync(plugin,{recursive:true});
writeFileSync(join(plugin,'index.html'),html);

const width=128,height=128;
const pixels=Buffer.alloc((1+width*4)*height);
function rgba(x,y,r,g,b,a=255){
  const i=y*(1+width*4)+1+4*x;
  pixels[i]=r;pixels[i+1]=g;pixels[i+2]=b;pixels[i+3]=a;
}
for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const dx=x-63.5,dy=y-63.5;
  const inside=dx*dx+dy*dy<4000;
  rgba(x,y,241,243,247,inside?255:0);
  if(x>=32&&x<=96&&y>=12&&y<=116)rgba(x,y,38,50,65);
  if(x>=39&&x<=89&&y>=21&&y<=107)rgba(x,y,246,216,229);
  if(x>=43&&x<=85&&y>=35&&y<=43)rgba(x,y,230,159,185);
  if(x>=43&&x<=85&&y>=49&&y<=55)rgba(x,y,205,150,173);
  if(x>=43&&x<=85&&y>=60&&y<=75)rgba(x,y,248,235,239);
  if(x>=43&&x<=85&&y>=80&&y<=92)rgba(x,y,205,150,173);
  if(x>=54&&x<=74&&y>=18&&y<=22)rgba(x,y,18,24,32);
}
const crcTable=Array.from({length:256},(_,i)=>{
  let c=i;for(let n=0;n<8;n++)c=c&1?0xEDB88320^(c>>>1):c>>>1;return c>>>0;
});
function crc32(data){let c=0xFFFFFFFF;for(const b of data)c=crcTable[(c^b)&255]^(c>>>8);return(c^0xFFFFFFFF)>>>0}
function chunk(name,data){const type=Buffer.from(name,'ascii'),header=Buffer.alloc(8);header.writeUInt32BE(data.length,0);header.writeUInt32BE(crc32(Buffer.concat([type,data])),4);return Buffer.concat([header,type,data])}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
writeFileSync(join(plugin,'logo.png'),png);
function zipStore(entries){
  const locals=[],centers=[];let offset=0;
  for(const [name,bytes] of entries){
    const b=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes),filename=Buffer.from(name);
    const crc=crc32(b),head=Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50,0);head.writeUInt16LE(20,4);
    head.writeUInt16LE(0,6);head.writeUInt16LE(0,8);head.writeUInt32LE(crc,14);
    head.writeUInt32LE(b.length,18);head.writeUInt32LE(b.length,22);head.writeUInt16LE(filename.length,26);
    locals.push(head,filename,b);
    const c=Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50,0);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);
    c.writeUInt32LE(crc,16);c.writeUInt32LE(b.length,20);c.writeUInt32LE(b.length,24);
    c.writeUInt16LE(filename.length,28);c.writeUInt32LE(offset,42);
    centers.push(c,filename);offset+=head.length+filename.length+b.length;
  }
  const csize=centers.reduce((n,b)=>n+b.length,0),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(csize,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,...centers,end]);
}
const zip=zipStore([['manifest.json',readFileSync(join(plugin,'manifest.json'))],['logo.png',png],['index.html',html]]);
mkdirSync(join(root,'release'),{recursive:true});
const output=join(root,'release','Eagle-Detail-Preview-'+manifest.version+'.eagleplugin');
writeFileSync(output,zip);
console.log(JSON.stringify({status:'built',plugin,output,manifestId:manifest.id,htmlBytes:html.length,pngBytes:png.length,packageBytes:zip.length},null,2));
