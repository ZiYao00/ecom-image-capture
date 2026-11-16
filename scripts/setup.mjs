#!/usr/bin/env node
// Idempotent per-machine initialization. Does not install software, migrate data or login.
import {existsSync,readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveOutputRoot} from './capture-policy.mjs';
import {readRegistry} from './capture-store.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args.length>1||args.some(x=>!['--check'].includes(x)))throw Error('Usage: node scripts/setup.mjs [--check]');
const checkOnly=args.includes('--check');
const cfgDir=join(root,'config'),dataDir=join(root,'data'),registry=join(dataDir,'captures.json');
const config=join(cfgDir,'local.json'),template=join(cfgDir,'local.example.json');
if(!existsSync(template))throw Error('Missing config/local.example.json');
const hadRegistry=existsSync(registry),hadConfig=existsSync(config);
if(hadRegistry)readRegistry(root);
const settings=hadConfig?JSON.parse(readFileSync(config,'utf8')):{};
const output=resolveOutputRoot(root,null,settings.outputRoot);
const willCreate=[!existsSync(registry)?registry:null,!existsSync(config)?config:null,!existsSync(output)?output:null].filter(Boolean);
if(!checkOnly){
  mkdirSync(cfgDir,{recursive:true});mkdirSync(dataDir,{recursive:true});
  if(!existsSync(registry))writeFileSync(registry,JSON.stringify({schemaVersion:1,products:{}},null,2)+'\n',{flag:'wx'});
  if(!existsSync(config))copyFileSync(template,config);
  mkdirSync(output,{recursive:true});
}
console.log(JSON.stringify({status:checkOnly?'checked':'initialized',root,outputRoot:output,registry:hadRegistry?'existing':(checkOnly?'missing':'created'),config:hadConfig?'existing':(checkOnly?'missing':'created'),wouldCreate:checkOnly?willCreate:[],changed:!checkOnly&&willCreate.length>0},null,2));
