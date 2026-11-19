#!/usr/bin/env node
// Current Eagle classified truth; historical receipt is immutable. --check is
// read-only. Apply may attach verified existing Eagle items but never item_add.
import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {acquireProductLock} from './capture-store.mjs';
import {archiveEagleProduct,eagleArchiveRpc} from './eagle-archive.mjs';
import {readCurrentEagleProduct,hashEagleFile} from './eagle-current.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),checkOnly=args.includes('--check');
const remaining=args.filter(x=>x!=='--check');
const productId=remaining[0],date=remaining[1];
if(remaining.length<1||remaining.length>2||!/^[0-9]{8,16}$/.test(productId||'')||
   (date&&!/^\d{4}-\d{2}-\d{2}$/.test(date))){
  console.error(JSON.stringify({status:'invalid_arguments',
    usage:'archive <productId> [YYYY-MM-DD] [--check]'}));
  process.exit(2);
}
const receiptFile=join(root,'data','runs','stable-'+productId,'receipt.json');
if(!existsSync(receiptFile))throw Error('Existing stable receipt not found: '+productId);
const receipt=JSON.parse(readFileSync(receiptFile,'utf8'));
if(receipt.productId!==productId||!Array.isArray(receipt.images))throw Error('Invalid stable receipt');
const local=(path)=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
const cfg={...local(join(root,'config/local.example.json')),...local(join(root,'config/local.json'))};
const endpoint=process.env.EAGLE_MCP_URL||cfg.eagleMcpUrl;
if(!endpoint)throw Error('Eagle MCP URL missing');
const rpc=(name,args)=>eagleArchiveRpc(endpoint,name,args);
const rootName=date?'天猫批量采集_'+date:receipt.archive?.rootName||null;
let unlock;
try{
  if(!checkOnly)unlock=acquireProductLock(root,productId);
  const read=()=>readCurrentEagleProduct({rpc,productId,
    images:receipt.images,rootName});
  let current=await read(),assigned=0;
  if(!checkOnly&&current.status!=='complete'){
    if(!current.folders){
      // Never guess today's batch for a historical product.
      if(!rootName)throw Error('Historical Eagle root not found. Supply YYYY-MM-DD explicitly.');
      await archiveEagleProduct({rpc,productId,images:receipt.images,rootName,apply:true});
      current=await read();
    }
    if(current.folders?.mainFolderId&&current.folders?.detailFolderId){
      // Independently repaired images can have NEW itemIds not in original receipt.
      const lookup=await rpc('item_get',{keywords:[productId],limit:1000,fullDetails:true});
      const all=Array.isArray(lookup)?lookup:lookup.items||[];
      for(const name of [...current.missing,...current.invalid.map(x=>x.name)]){
        const original=receipt.images.find(x=>x.name===name);
        if(!original)continue;
        const options=all.filter(x=>x.name===name);
        if(options.length>1)throw Error('Ambiguous Eagle repair candidates for '+name);
        if(options.length!==1)continue;
        const candidate=options[0],actualFile=await hashEagleFile(candidate);
        if(!actualFile.bytes||!(candidate.width>0)||!(candidate.height>0))
          throw Error('Eagle candidate is not a readable image '+name);
        const target=original.category==='main'?current.folders.mainFolderId:current.folders.detailFolderId;
        if(!(candidate.folders||[]).includes(target)){
          await rpc('item_add_to_folders',{ids:[candidate.id],folders:[target]});
          assigned++;
        }
      }
      current=await read();
    }
  }
  const summary={operation:'archive',status:current.status,productId,rootName:current.rootName,
    expected:current.expected,classified:current.counts,missing:current.missing,
    invalid:current.invalid,formatChanges:current.formatChanges,unrelated:current.unrelated,
    assigned,folderIds:current.folders,
    previousReceipt:{phase:receipt.phase,eagle:receipt.eagle},
    receiptChanged:false,checkOnly};
  if(!checkOnly){
    // Material truth snapshots are a separate audit trail, NEVER overwritten receipt.
    const dir=join(root,'data','reconciliations');
    mkdirSync(dir,{recursive:true});
    const stamp=new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14);
    const path=join(dir,'eagle-current-'+productId+'-'+stamp+'-'+randomUUID().slice(0,6)+'.json');
    writeFileSync(path,JSON.stringify({checkedAt:new Date().toISOString(),...summary,
      items:current.items},null,2)+'\n',{flag:'wx'});
    summary.snapshot=path;
  }
  console.log(JSON.stringify(summary,null,2));
  if(current.status!=='complete')process.exitCode=2;
}catch(e){
  console.error(JSON.stringify({operation:'archive',status:'needs_read_only_review',
    productId,error:String(e?.message||e),receiptChanged:false,noAutomaticRetry:true},null,2));
  process.exitCode=2;
}finally{unlock?.()}
