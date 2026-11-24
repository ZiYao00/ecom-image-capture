// Restore the local delivery of a proven Eagle snapshot without touching historical receipts.
// A file already at the target path is reused only when its content hash is identical.
import {existsSync,lstatSync,readdirSync,mkdirSync,copyFileSync,constants,createReadStream,readFileSync} from 'node:fs';
import {resolve,join,basename,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {generateDetailPreview} from './html-preview.mjs';
const safeExt=new Set(['jpg','jpeg','png','gif','webp']);
async function digest(file){
 const st=lstatSync(file);
 if(!st.isFile()||st.isSymbolicLink()||!st.size)throw Error('Invalid local delivery file: '+file);
 const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
 return hash.digest('hex');
}
function safeDir(dir){
 if(existsSync(dir)){
  const s=lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink())throw Error('Unsafe local output directory: '+dir);
 }
}
export async function ensureCopyDelivery(snapshot,outputDir,{apply=false}={}){
 if(snapshot?.status!=='complete'||!Array.isArray(snapshot.items)||!snapshot.items.length||!outputDir||
   basename(resolve(outputDir))!==String(snapshot.productId))throw Error('Copy delivery requires complete Eagle proof and recorded outputDir');
 const dest=resolve(outputDir),rows=[],expected=new Map();
 safeDir(dest);
 for(const item of snapshot.items){
  const ext=String(item.ext||'').toLowerCase();
  if(!['main','detail'].includes(item.category)||!Number.isInteger(item.order)||item.order<1||
    !safeExt.has(ext)||!/^[a-f0-9]{64}$/.test(item.sha256||'')||!item.filePath)throw Error('Invalid proven copy slot');
  const dir=join(dest,item.category);safeDir(dir);
  const name=String(item.order).padStart(2,'0')+'.'+ext,key=item.category+'/'+name;
  if(expected.has(key))throw Error('Duplicate delivery slot '+key);
  expected.set(key,item);
  const file=join(dir,name),present=existsSync(file);
  if(present&&await digest(file)!==item.sha256)throw Error('Destination content conflict; not overwritten: '+key);
  rows.push({key,dir,file,source:item.filePath,sha256:item.sha256,present});
 }
 for(const cat of ['main','detail']){
  const d=join(dest,cat);if(!existsSync(d))continue;
  for(const name of readdirSync(d))if(/^\d{1,4}\.(jpg|jpeg|png|gif|webp)$/i.test(name)&&!expected.has(cat+'/'+name))
    throw Error('Unexpected numbered delivery file; preserve and inspect: '+cat+'/'+name);
 }
 const htmlPath=join(dest,'detail','HTML.html');
 if(existsSync(htmlPath)){
  const s=lstatSync(htmlPath);if(!s.isFile()||s.isSymbolicLink())throw Error('Unsafe preview path');
  if(!readFileSync(htmlPath,'utf8').includes('<!-- ecom-image-capture:generated-preview:v1 -->'))throw Error('Existing hand-edited HTML.html; preserve and review');
 }
 // Check the entire destination and source hash before the first local copy.
 if(apply){
  for(const row of rows.filter(x=>!x.present))if(await digest(row.source)!==row.sha256)throw Error('Source changed before local copy: '+row.key);
  for(const row of rows.filter(x=>!x.present)){
   mkdirSync(row.dir,{recursive:true});safeDir(row.dir);
   copyFileSync(row.source,row.file,constants.COPYFILE_EXCL);
   if(await digest(row.file)!==row.sha256)throw Error('Copied bytes do not verify: '+row.key);
  }
 }
 const missing=apply?[]:rows.filter(x=>!x.present).map(x=>x.key);
 if(missing.length)return {status:'incomplete',mode:'copy',verified:rows.length-missing.length,missing,htmlStatus:'not_checked'};
 const html=generateDetailPreview(join(dest,'detail'),{productId:snapshot.productId,checkOnly:!apply});
 const htmlProof=apply?generateDetailPreview(join(dest,'detail'),{productId:snapshot.productId,checkOnly:true}):html;
 return {status:htmlProof.status==='unchanged'?'complete':'incomplete',mode:'copy',verified:rows.length,
   copied:apply?rows.filter(x=>!x.present).length:0,missing,htmlStatus:htmlProof.status,outputDir:dest};
}
export async function verifyDeliveryMode(snapshot,receipt,record,{apply=false}={}){
 if(snapshot?.status!=='complete')throw Error('Delivery mode verification requires complete Eagle originals');
 const mode=receipt.storageMode||record?.storageMode||'copy';
 if(mode==='eagle')return {status:'complete',mode:'eagle',localCopiesRequired:false};
 if(mode!=='copy')throw Error('Unknown recorded storage mode: '+mode);
 return ensureCopyDelivery(snapshot,record?.outputDir||receipt.destination,{apply});
}
