#!/usr/bin/env node
// Public Windows ZIP: one reviewed source allowlist, never private runtime data.
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
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
for(const f of files)if(!existsSync(join(root,f)))throw Error('Required public file missing: '+f);
if(existsSync(destination))throw Error('Archive already exists; refuse to overwrite: '+destination);
mkdirSync(dirname(destination),{recursive:true});
const relArchive=join('release',archiveName);
const command=spawnSync('tar',['-a','-cf',relArchive,...files],{
 cwd:root,windowsHide:true,encoding:'utf8',timeout:120000});
if(command.error||command.status!==0)
 throw Error('Windows tar packaging failed: '+String(command.error||command.stderr));
const listing=spawnSync('tar',['-tf',relArchive],{
 cwd:root,windowsHide:true,encoding:'utf8',timeout:30000});
if(listing.error||listing.status!==0)
 throw Error('ZIP listing failed: '+String(listing.error||listing.stderr));
const zipped=listing.stdout.split(/\r?\n/).filter(Boolean)
  .map(x=>x.replaceAll('\\','/').replace(/^\.\//,''));
const missing=files.filter(x=>!zipped.includes(x));
const extra=zipped.filter(x=>!files.includes(x));
const prohibited=zipped.filter(x=>/^(?:data\/|output\/|release\/|config\/local\.json$|profile\/|runtime\/|node_modules\/)/i.test(x));
if(missing.length||extra.length||prohibited.length)
 throw Error('Public ZIP manifest verification failed '+JSON.stringify({missing,extra,prohibited}));
const bytes=readFileSync(destination);
const sha256=createHash('sha256').update(bytes).digest('hex');
console.log(JSON.stringify({
 status:'packaged',path:destination,files:files.length,bytes:bytes.length,sha256,
 excluded:'local config, profiles, private images, receipts, historical docs and cleanup tools'
},null,2));
