import {readFileSync,existsSync,statSync,copyFileSync,mkdirSync,renameSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
export function repairCopyState(receipt,copy) {
 const total=receipt.images?.length??0;
 const valid=receipt.eagle==='verified' && receipt.images.every(x=>x.verified===true&&x.filePath&&x.itemId);
 const clean=copy.errors.length===0 && copy.copied===total;
 return {phase:valid&&clean?'success':'incomplete',copied:copy.copied,destination:copy.destination,
  errors:[...(receipt.errors||[]),...copy.errors]};
}
export function uniqueExactMatches(expected,items){
 const matches=new Map(),issues=[];
 for(const x of expected){
  const candidates=items.filter(i=>i.name===x.name);
  if(candidates.length!==1) {issues.push(x.name+': expected one exact Eagle name, got '+candidates.length);continue;}
  const item=candidates[0];
  if(!item.id&&!item.itemId){issues.push(x.name+': ID missing');continue}
  if(!item.filePath||!(item.width>0&&item.height>0)){issues.push(x.name+': file metadata missing');continue}
  matches.set(x.name,item);
 }
 return {matches,issues};
}
export function applyRecovered(receipt,matches){
 const next=structuredClone(receipt);
 for(const x of next.images||[]){
  if(x.verified===true)continue;
  const m=matches.get(x.name);
  if(!m)continue;
  x.itemId=m.itemId||m.id;
  x.filePath=m.filePath;
  x.ext=m.ext||'jpg';
  x.savedWidth=m.width;x.savedHeight=m.height;
  x.verified=true;x.acknowledged=true;
 }
 next.eagle=next.images.every(x=>x.verified===true)?'verified':'partially_verified';
 return next;
}
