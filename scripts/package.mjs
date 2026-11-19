#!/usr/bin/env node
// Public Windows ZIP: one reviewed source allowlist, true ZIP bytes, never
// private runtime data. Node-only packaging: no host-specific tar flags.
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {publicFiles} from './public-files.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const argv=process.argv.slice(2);
if(argv.length!==0&&(argv.length!==2||argv[0]!=='--tag'||!/^[a-zA-Z0-9._-]{1,64}$/.test(argv[1])))
  throw Error('Usage: node scripts/package.mjs [--tag <version>]');
const tag=argv[1]||new Date().toISOString().slice(0,10).replaceAll('-','');
const archiveName='ecom-image-capture-windows-portable-'+tag+'.zip';
const destination=join(root,'release',archiveName);
const files=publicFiles(root);
for(const f of files){
  if(!existsSync(join(root,f)))throw Error('Required public file missing: '+f);
  if(/^(?:data\/|output\/|release\/|runtime\/|profile\/|node_modules\/|config\/local\.json$)/i.test(f))
    throw Error('Private file attempted in public archive: '+f);
}
if(existsSync(destination))throw Error('Archive already exists; refuse to overwrite: '+destination);
function crcTable(){
  return Array.from({length:256},(_,i)=>{
    let c=i;for(let j=0;j<8;j++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);return c>>>0;
  });
}
const table=crcTable();
function crc32(data){
  let crc=0xFFFFFFFF;
  for(const x of data)crc=table[(crc^x)&255]^(crc>>>8);
  return(crc^0xFFFFFFFF)>>>0;
}
function buildZip(entries){
  if(entries.length>0xffff)throw Error('Too many ZIP members');
  const local=[],central=[];let offset=0;
  for(const [name,content] of entries){
    if(!/^[\x20-\x7E]+$/.test(name))throw Error('ZIP path must be ASCII: '+name);
    const filename=Buffer.from(name,'utf8');
    const data=Buffer.isBuffer(content)?content:Buffer.from(content);
    if(filename.length>0xffff||data.length>0xffffffff)throw Error('ZIP entry too large: '+name);
    const crc=crc32(data),head=Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50,0);
    head.writeUInt16LE(20,4); // ZIP 2.0
    head.writeUInt32LE(crc,14);
    head.writeUInt32LE(data.length,18);
    head.writeUInt32LE(data.length,22);
    head.writeUInt16LE(filename.length,26);
    local.push(head,filename,data);
    const dir=Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50,0);
    dir.writeUInt16LE(20,4);
    dir.writeUInt16LE(20,6);
    dir.writeUInt32LE(crc,16);
    dir.writeUInt32LE(data.length,20);
    dir.writeUInt32LE(data.length,24);
    dir.writeUInt16LE(filename.length,28);
    dir.writeUInt32LE(offset,42);
    central.push(dir,filename);
    offset+=head.length+filename.length+data.length;
  }
  const size=central.reduce((n,b)=>n+b.length,0);
  if(offset>0xffffffff||size>0xffffffff)throw Error('ZIP64 required; release exceeds standard ZIP limits');
  const eocd=Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0);
  eocd.writeUInt16LE(entries.length,8);
  eocd.writeUInt16LE(entries.length,10);
  eocd.writeUInt32LE(size,12);
  eocd.writeUInt32LE(offset,16);
  return Buffer.concat([...local,...central,eocd]);
}
const archive=buildZip(files.map(f=>[f.replaceAll('\\','/'),readFileSync(join(root,f))]));
// Prevent a TAR or arbitrary blob from being falsely named ".zip".
const end=archive.subarray(-22);
if(archive.readUInt32LE(0)!==0x04034b50||end.readUInt32LE(0)!==0x06054b50||
   end.readUInt16LE(10)!==files.length)
  throw Error('ZIP signature/member-count self-check failed');
mkdirSync(dirname(destination),{recursive:true});
writeFileSync(destination,archive,{flag:'wx'});
const sha256=createHash('sha256').update(archive).digest('hex');
console.log(JSON.stringify({
  status:'packaged',archiveFormat:'ZIP',path:destination,
  files:files.length,bytes:archive.length,sha256,
  excluded:'local config, profiles, private images, receipts, historical docs and cleanup tools'
},null,2));
