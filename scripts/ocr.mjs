#!/usr/bin/env node
// Optional OCR entrypoint. Uses existing isolated RapidOCR, never changes original images.
import {existsSync,readFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {readRegistry} from './capture-store.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),id=args[0]==='--product'?args[1]:null;
if(!/^\d{8,16}$/.test(id||'')||args.length!==2)
 throw Error('Usage: node scripts/ocr.mjs --product <productId>');
const record=readRegistry(root).products[id];
if(!record?.outputDir)throw Error('No recorded product directory for '+id);
const configPath=join(root,'config','local.json');
const config=existsSync(configPath)?JSON.parse(readFileSync(configPath,'utf8')):{};
const bundledOCR=join(root,'runtime','ocr','.venv','Scripts','python.exe');
const legacyOCR=join(root,'..','AI-Runtime','ocr','.venv','Scripts','python.exe');
const python=resolve(root,process.env.ECOM_OCR_PYTHON||config.ocrPython||
  (existsSync(bundledOCR)?bundledOCR:config.chromeMode==='shared'&&existsSync(legacyOCR)?legacyOCR:bundledOCR));
if(!existsSync(python))throw Error('OCR runtime missing: '+python+'; see docs/INSTALL-WINDOWS.md');
const worker=join(root,'scripts','ocr-worker.py');
const r=spawnSync(python,['-B',worker,record.outputDir,id],{
  cwd:root,windowsHide:true,encoding:'utf8',timeout:300000,maxBuffer:8*1024*1024,
  env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'}
});
if(r.error||r.status!==0)throw Error('OCR worker failed: '+String(r.error||r.stderr||r.stdout).slice(0,1500));
console.log(r.stdout.trim());
