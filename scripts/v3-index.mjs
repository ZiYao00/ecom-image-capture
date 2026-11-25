#!/usr/bin/env node
// Eagle-only V3 index CLI. --check does not write. --build only writes a local ignored SQLite cache.
import {resolve,join,dirname} from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {eagleArchiveRpc} from './eagle-archive.mjs';
import {holdWorkflowLock} from './workflow-lock.mjs';
import {listWebApiItems,makeIndexRows,openFingerprintDatabase,refreshFingerprintIndex} from './v3-fingerprint.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [mode,limitArg]=process.argv.slice(2);
if(!['--check','--build','--full'].includes(mode)||(mode!=='--check'&&limitArg)||
  (limitArg&&!/^[0-9]{1,4}$/.test(limitArg))||process.argv.length>4)
  throw Error('Usage: node scripts/v3-index.mjs --check [sampleCount] | --build | --full');
const read=n=>{try{return JSON.parse(readFileSync(join(root,'config',n),'utf8'))}catch{return {}}};
const config={...read('local.example.json'),...read('local.json')};
const eagleUrl=process.env.EAGLE_MCP_URL||config.eagleMcpUrl;
if(!eagleUrl)throw Error('Eagle MCP not configured');
if(mode!=='--check')holdWorkflowLock(root);
const info=await eagleArchiveRpc(eagleUrl,'get_app_info',{});
if(!info?.libraryPath)throw Error('Eagle library path missing');
let report;
if(mode==='--check'){
  const inventory=await listWebApiItems();
  const inspected=await makeIndexRows(info.libraryPath,inventory.items,{maxInspect:Number(limitArg||40)});
  report={status:'read_only_checked',operation:mode,libraryPath:info.libraryPath,
    libraryItemTotal:inventory.total,imageEligible:inspected.eligible,inspected:inspected.inspected,
    indexable:inspected.rows.length,unavailable:inspected.invalid.slice(0,20),
    unavailableCount:inspected.invalid.length,ignoredNonImages:inspected.skipped,dbModified:false};
}else{
  const indexPath=join(root,'data','fingerprints','v3-eagle.sqlite');
  const index=await openFingerprintDatabase(indexPath,{libraryPath:info.libraryPath});
  try{
    const listItems=async()=>{
      const active=await eagleArchiveRpc(eagleUrl,'get_app_info',{});
      if(!active?.libraryPath||resolve(active.libraryPath).toLowerCase()!==resolve(info.libraryPath).toLowerCase())
        throw Error('Active Eagle library identity changed');
      return listWebApiItems();
    };
    report={...(await refreshFingerprintIndex(index,info.libraryPath,{full:mode==='--full',listItems})),
      operation:mode,indexPath,libraryPath:info.libraryPath};
  }catch(error){
    report={status:'not_safe_to_activate',operation:mode,dbModified:false,error:String(error.message||error)};
    process.exitCode=2;
  }finally{index.close();}
}
console.log(JSON.stringify(report,null,2));
