// Read-only historical source-URL index. An URL gives candidate IDs, never
// proof of identical image bytes by itself. The resolver additionally requires
// physical Eagle membership in the target category folder.
import {readdirSync,existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {loadMap} from './eagle-product-map.mjs';
export function sourceCandidates(root,{excludeProductId=null,maxReceipts=5000}={}){
 const map=new Map(),push=(url,id)=>{
  if(!url||!id)return;
  const ids=map.get(url)||new Set();ids.add(id);map.set(url,ids);
 };
 const dir=join(root,'data','runs');
 const entries=existsSync(dir)?readdirSync(dir,{withFileTypes:true})
  .filter(x=>x.isDirectory()&&/^stable-\d{8,16}$/.test(x.name)):[];
 if(entries.length>maxReceipts)throw Error('Too many Eagle receipt files for bounded index');
 for(const entry of entries){
  const id=entry.name.slice(7);
  if(id===String(excludeProductId))continue;
  const path=join(dir,entry.name,'receipt.json');
  if(!existsSync(path))continue;
  const receipt=JSON.parse(readFileSync(path,'utf8'));
  const existing=loadMap(root,id,receipt.images);
  if(existing)for(const slot of existing.slots)
   if(slot.itemId)push(slot.sourceUrl,slot.itemId);
  else {/* no mapping for unresolved slot */}
  // Fall back to initial physically acknowledged IDs for older completed sources.
  if(!existing)for(const slot of receipt.images||[])
   if(slot.verified===true&&slot.itemId)push(slot.url,slot.itemId);
 }
 return new Map([...map].map(([url,ids])=>[url,[...ids]]));
}
