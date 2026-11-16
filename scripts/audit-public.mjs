#!/usr/bin/env node
// Read-only public-source gate. Does not stage, commit, push or print secrets.
import {existsSync,readFileSync,statSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {publicFiles} from './public-files.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const wanted=publicFiles(root);
const allowed=new Set(wanted);
const failures=[];
const failed=(why,file)=>failures.push({reason:why,file});
const patterns=[
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,'private key'],
  [/(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{30,}/,'GitHub token'],
  [/(?:sk-proj-|sk-)[A-Za-z0-9_-]{32,}/,'API token'],
  [/AKIA[0-9A-Z]{16}/,'AWS access key']
];
for(const f of wanted){
  const target=join(root,f);
  if(!existsSync(target)){failed('required file missing',f);continue;}
  if(statSync(target).size>2*1024*1024)failed('public source file exceeds 2 MiB',f);
  const body=readFileSync(target,'utf8');
  for(const [re,label] of patterns)if(re.test(body))failed('possible '+label,f);
}
const gitRepository=existsSync(join(root,'.git'));
const result=gitRepository?spawnSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{
 cwd:root,encoding:'utf8',windowsHide:true,timeout:12000,maxBuffer:3*1024*1024
}):null;
if(!gitRepository){
 // A distributed ZIP intentionally has no .git directory. It still gets file/content checks.
}else if(result.error||result.status!==0){
 failed('git source inventory unavailable: '+String(result.error||result.stderr).slice(0,130),'git');
}else{
 const stageable=result.stdout.split('\0').filter(Boolean).map(x=>x.replaceAll('\\','/'));
 for(const f of stageable)if(!allowed.has(f))failed('unexpected stageable path',f);
 for(const f of wanted)if(!stageable.includes(f))failed('expected public file ignored/not stageable',f);
}
console.log(JSON.stringify({
 status:failures.length?'failed':'passed',publicFiles:wanted.length,
 gitRepository,stageableFiles:result?.status===0?result.stdout.split('\0').filter(Boolean).length:null,
 issues:failures,
 note:gitRepository
  ?'Git candidates checked; this is not a substitute for manual privacy review.'
  :'Distribution mode without .git: content checked, Git staging comparison skipped.'
},null,2));
if(failures.length)process.exitCode=2;
