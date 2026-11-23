#!/usr/bin/env node
// Eagle-only V3 index CLI. --check does not write. --build only writes a local ignored SQLite cache.
import {resolve,join,dirname} from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {eagleArchiveRpc} from './eagle-archive.mjs';
import {listWebApiItems,makeIndexRows,openFingerprintDatabase} from './v3-fingerprint.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [mode,limitArg]=process.argv.slice(2);
if(!['--check','--build'].includes(mode)||(mode==='--build'&&limitArg)||
  (limitArg&&!/^[0-9]{1,4}$/.test(limitArg)))throw Error('Usage: node scripts/v3-index.mjs --check [sampleCount] | --build');
const read=n=>{try{return JSON.parse(readFileSync(join(root,'config',n),'utf8'))}catch{return {}}};
const config={...read('local.example.json'),...read('local.json')};
const eagleUrl=process.env.EAGLE_MCP_URL||config.eagleMcpUrl;
if(!eagleUrl)throw Error('Eagle MCP not configured');
const info=await eagleArchiveRpc(eagleUrl,'get_app_info',{});
if(!info?.libraryPath)throw Error('Eagle library path missing');
const inventory=await listWebApiItems();
const checkOnly=mode==='--check';
const sample=checkOnly?Number(limitArg||40):null;
const inspected=await makeIndexRows(info.libraryPath,inventory.items,{maxInspect:sample});
const report={status:checkOnly?'read_only_checked':inspected.invalid.length?'index_built_with_missing_sources':'index_ready',
  operation:mode,libraryPath:info.libraryPath,libraryItemTotal:inventory.total,
  imageEligible:inspected.eligible,inspected:inspected.inspected,indexable:inspected.rows.length,
  unavailable:inspected.invalid.slice(0,20),unavailableCount:inspected.invalid.length,
  ignoredNonImages:inspected.skipped,dbModified:false};
if(!checkOnly){
  // A partial index cannot be used as exhaustive de-duplication evidence.
  if(inspected.invalid.length){
    report.status='not_safe_to_activate';
    console.log(JSON.stringify(report,null,2));
    process.exitCode=2;
  }else {
    const path=join(root,'data','fingerprints','v3-eagle.sqlite');
    const index=await openFingerprintDatabase(path,{libraryPath:info.libraryPath});
    try{
      report.generation=index.writeGeneration(inspected.rows,{libraryItemTotal:inventory.total});
      report.indexPath=path;
      report.dbModified=true;
    }finally{index.close()}
  }
}
console.log(JSON.stringify(report,null,2));
