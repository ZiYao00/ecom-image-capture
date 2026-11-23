#!/usr/bin/env node
// V3 diagnostic: scan image bytes and local fingerprint index; zero Eagle writes.
import {readFileSync,existsSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {eagleArchiveRpc} from './eagle-archive.mjs';
import {openFingerprintDatabase} from './v3-fingerprint.mjs';
import {fetchOriginalBytes,validateOriginalRepresentation,saveCacheFile} from './v3-prefetch.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [mode,id]=process.argv.slice(2);
if(!['--check','--cache'].includes(mode)||!/^[0-9]{8,16}$/.test(id||'')||process.argv.length!==4)
 throw Error('Usage: node scripts/v3-verify-prefetch.mjs --check|--cache <existingProductId>');
const receiptFile=join(root,'data','runs','stable-'+id,'receipt.json');
if(!existsSync(receiptFile))throw Error('Existing product receipt missing');
const r=JSON.parse(readFileSync(receiptFile,'utf8'));
if(r.productId!==id||!r.images?.length)throw Error('Receipt invalid');
const cfgName=n=>{try{return JSON.parse(readFileSync(join(root,'config',n),'utf8'))}catch{return {}}};
const cfg={...cfgName('local.example.json'),...cfgName('local.json')};
const app=await eagleArchiveRpc(cfg.eagleMcpUrl,'get_app_info',{});
const path=join(root,'data','fingerprints','v3-eagle.sqlite');
if(!existsSync(path))throw Error('V3 index not built; use v3-index.mjs --build');
const db=await openFingerprintDatabase(path,{libraryPath:app.libraryPath});
const results=[];
try{
  for(const slot of r.images){
    try{
      const response=await fetchOriginalBytes(slot.url);
      const representation=validateOriginalRepresentation(slot.url,response.ext);
      const matched=db.lookup(response.sha256);
      const evidence={name:slot.name,sha256:response.sha256,bytes:response.size,format:response.ext,
        representation:representation.status,expectedEagleHash:slot.sha256||null,
        matchesEagleReceipt:slot.sha256?slot.sha256===response.sha256:null,
        indexedCandidates:matched.map(x=>x.id)};
      if(mode==='--cache')evidence.cachedFile=saveCacheFile(root,id,slot,response);
      results.push(evidence);
    }catch(error){results.push({name:slot.name,error:String(error.message||error)})}
  }
}finally{db.close()}
const problems=results.filter(x=>x.error||!x.indexedCandidates?.length||x.representation==='representation_changed');
console.log(JSON.stringify({status:problems.length?'needs_review':'all_sources_match',
   productId:id,checked:results.length,matched:results.length-problems.length,problems,all:results,
   eagleWrites:0,cacheWrites:mode==='--cache'?'cache_only':0},null,2));
if(problems.length)process.exitCode=2;
