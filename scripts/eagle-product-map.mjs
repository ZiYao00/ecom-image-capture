// Per-product logical image positions, independent from globally named Eagle assets.
import {readFileSync,writeFileSync,existsSync,mkdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const start='[ECOM-PRODUCT-MAP-V1]',end='[/ECOM-PRODUCT-MAP-V1]';
const pid=x=>/^\d{8,16}$/.test(String(x));
const eid=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{8,64}$/.test(x);
export const mapPath=(root,id)=>join(root,'data','product-maps',String(id)+'.json');
export function validateMap(map,images=null){
 if(!map||map.schemaVersion!==1||map.platform!=='tmall'||!pid(map.productId)||
    !Array.isArray(map.slots)||!map.slots.length)throw Error('Invalid Eagle product map');
 const unique=new Set(),counts={main:0,detail:0};
 for(const s of map.slots){
  if(!s||!['main','detail'].includes(s.category)||!Number.isInteger(s.order)||s.order<1||
     !s.name?.startsWith('Tmall-'+map.productId+'-'+s.category+'-')||
     typeof s.sourceUrl!=='string'||!s.sourceUrl.startsWith('https://')||
     !['imported','reused','pending'].includes(s.resolution)||
     (s.itemId!==null&&!eid(s.itemId))||
     (s.resolution==='pending')!==(s.itemId===null)||
     (s.itemId&&!/^[a-f0-9]{64}$/.test(s.sha256||'')))
    throw Error('Invalid map slot '+s?.name);
  const key=s.category+':'+s.order;if(unique.has(key))throw Error('Duplicate image position '+key);
  unique.add(key);counts[s.category]++;
 }
 for(const category of ['main','detail'])
  for(let i=1;i<=counts[category];i++)if(!unique.has(category+':'+i))throw Error('Noncontiguous order');
 if(images){
  if(images.length!==map.slots.length)throw Error('Map/receipt count disagreement');
  for(const x of images){
   const s=map.slots.find(s=>s.category===x.category&&s.order===x.order);
   if(!s||s.name!==x.name||s.sourceUrl!==x.url)throw Error('Map/receipt source conflict '+x.name);
  }
 }
 if(map.status!==(map.slots.every(x=>x.itemId)?'complete':'partial'))
  throw Error('Map status/slots disagree');
 return map;
}
export function makeMap(productId,images,{libraryPath=null,folders=null}={}){
 const slots=images.map(x=>({
  category:x.category,order:x.order,name:x.name,sourceUrl:x.url,
  itemId:x.verified&&x.itemId?x.itemId:null,
  resolution:x.verified&&x.itemId?(x.resolution==='reused'?'reused':'imported'):'pending',
  sha256:x.verified&&x.itemId?x.sha256:null
 }));
 return validateMap({schemaVersion:1,platform:'tmall',productId:String(productId),
  libraryPath,folders,status:slots.every(x=>x.itemId)?'complete':'partial',
  updatedAt:new Date().toISOString(),slots});
}
export function loadMap(root,id,images=null){
 const p=mapPath(root,id);if(!existsSync(p))return null;
 const map=JSON.parse(readFileSync(p,'utf8'));
 if(String(map.productId)!==String(id))throw Error('Map product mismatch');
 return validateMap(map,images);
}
export function saveMap(root,map){
 validateMap(map);
 const p=mapPath(root,map.productId),dir=join(root,'data','product-maps');
 if(existsSync(p)){
  const old=loadMap(root,map.productId);
  if(old.libraryPath&&map.libraryPath&&old.libraryPath!==map.libraryPath)
   throw Error('Eagle library mismatch across mappings');
  for(const prev of old.slots){
   const curr=map.slots.find(s=>s.category===prev.category&&s.order===prev.order);
   if(!curr||curr.sourceUrl!==prev.sourceUrl||curr.name!==prev.name||
      (prev.itemId&&prev.itemId!==curr.itemId))
    throw Error('Overwriting mapped source/identity is unsafe: '+prev.name);
  }
  if(JSON.stringify(old.slots)===JSON.stringify(map.slots))return {path:p,changed:false};
  mkdirSync(join(dir,'history'),{recursive:true});
  writeFileSync(join(dir,'history',map.productId+'-'+Date.now()+'-'+randomUUID().slice(0,6)+'.json'),
   JSON.stringify(old,null,2)+'\n',{flag:'wx'});
 }
 mkdirSync(dir,{recursive:true});
 const tmp=p+'.'+randomUUID().slice(0,6)+'.tmp';
 writeFileSync(tmp,JSON.stringify(map,null,2)+'\n',{flag:'wx'});
 renameSync(tmp,p);
 return {path:p,changed:true};
}
export function compactMap(map,category){
 validateMap(map);
 if(!['main','detail'].includes(category))throw Error('Invalid map category');
 return {v:1,pid:map.productId,c:category,
   items:map.slots.filter(s=>s.category===category&&s.itemId).map(s=>[s.order,s.itemId])};
}
export function parseFolderMap(description){
 const value=String(description||''),a=value.indexOf(start),b=value.indexOf(end);
 if(a<0&&b<0)return null;
 if(a<0||b<a||value.indexOf(start,a+start.length)>=0||value.indexOf(end,b+end.length)>=0)
  throw Error('Ambiguous folder-map metadata');
 const map=JSON.parse(value.slice(a+start.length,b).trim());
 if(map.v!==1||!pid(map.pid)||!['main','detail'].includes(map.c)||
    !Array.isArray(map.items)||!map.items.every(x=>Array.isArray(x)&&x.length===2&&
      Number.isInteger(x[0])&&x[0]>0&&eid(x[1]))||
    new Set(map.items.map(x=>x[0])).size!==map.items.length)throw Error('Invalid folder-map metadata');
 return map;
}
export function embedFolderMap(description,map,category){
 const old=String(description||'');
 const block=start+'\n'+JSON.stringify(compactMap(map,category))+'\n'+end;
 const a=old.indexOf(start),b=old.indexOf(end);
 let next;
 if(a<0&&b<0)next=old?old.trimEnd()+'\n\n'+block:block;
 else{parseFolderMap(old);next=old.slice(0,a)+block+old.slice(b+end.length)}
 if(next.length>10000)throw Error('Folder description would exceed safety limit');
 return next;
}
