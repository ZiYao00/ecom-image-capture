#!/usr/bin/env node
// Manage the canonical product index. No Eagle or Chrome calls.
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalProductUrl,readRegistry,updateProduct} from './capture-store.mjs';
import {resolveOutputRoot} from './capture-policy.mjs';
import {readFileSync,existsSync} from 'node:fs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [action,...args]=process.argv.slice(2);
if(action==='list'){
 const d=readRegistry(root),records=Object.values(d.products).sort((a,b)=>a.productId.localeCompare(b.productId));
 console.log(JSON.stringify({products:records.length,
  completed:records.filter(p=>p.status==='success').length,
  images:records.reduce((sum,p)=>sum+p.copiedCount,0),
  records:records.map(({productId,status,mainCount,detailCount,outputDir})=>({productId,status,mainCount,detailCount,outputDir}))},null,2));
}else if(action==='add'){
 if(args.length<1||args.length>2)throw Error('Usage: node scripts/captures.mjs add "<product URL>" ["<output root>"]');
 const product=canonicalProductUrl(args[0]);
 const old=readRegistry(root).products[product.productId];
 if(old?.status==='success'){
  console.log(JSON.stringify({status:'already_completed',productId:product.productId,changed:false}));process.exit(0);
 }
 if(old?.status && old.status!=='pending')throw Error('Product already has an active/failed receipt. Inspect existing run first: '+product.productId);
 const configPath=join(root,'config','local.json');
 const config=existsSync(configPath)?JSON.parse(readFileSync(configPath,'utf8')):{};
 const outputRoot=resolveOutputRoot(root,args[1],config.outputRoot);
 const patch={...product,status:'pending',mainCount:0,detailCount:0,verifiedCount:0,copiedCount:0,
   durationMs:null,outputDir:join(outputRoot,product.productId)};
 const saved=await updateProduct(root,patch);
 console.log(JSON.stringify({status:'registered',record:saved},null,2));
}else{
 console.log('node scripts/captures.mjs list');
 console.log('node scripts/captures.mjs add "<complete product URL>" ["<output root>"]');
 process.exitCode=action==='--help'||!action?0:2;
}
