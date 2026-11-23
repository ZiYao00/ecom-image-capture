// Publish the product order->itemId map into existing Eagle category folder descriptions.
// Only folder descriptions change. User text is preserved, image metadata is untouched.
import {validateMap,embedFolderMap,parseFolderMap} from './eagle-product-map.mjs';
const asItems=x=>Array.isArray(x)?x:(x?.folders||[]);
export async function mirrorEagleMap({rpc,map,apply=false}){
 validateMap(map);
 if(map.status!=='complete')throw Error('Incomplete product map cannot be published');
 if(!map.folders?.main||!map.folders?.detail)throw Error('Missing verified category folders');
 const plan=[];
 for(const category of ['main','detail']){
  const id=map.folders[category];
  const list=asItems(await rpc('folder_get',{ids:[id],fullDetails:true}));
  const folder=list.find(x=>x.id===id&&x.name===(category==='main'?'主图':'详情页'));
  if(!folder)throw Error('Eagle category folder metadata unavailable');
  const before=String(folder.description||'');
  const prior=parseFolderMap(before);
  if(prior&&(prior.pid!==map.productId||prior.c!==category))
   throw Error('Folder map belongs to another product/category');
  const after=embedFolderMap(before,map,category);
  plan.push({id,category,before,after,needsWrite:before!==after});
 }
 if(!apply)return {status:'ready',parts:plan.map(x=>({
  category:x.category,needsWrite:x.needsWrite,characters:x.after.length}))};
 for(const x of plan){
  if(!x.needsWrite)continue;
  // A prior uncertain write is never blindly retried; the caller must re-read first.
  await rpc('folder_update',{folders:[{id:x.id,description:x.after}]});
  const read=asItems(await rpc('folder_get',{ids:[x.id],fullDetails:true}))
    .find(y=>y.id===x.id);
  if(read?.description!==x.after)throw Error('Eagle mapping description not verified '+x.category);
 }
 return {status:'complete',parts:plan.map(x=>({category:x.category,verified:true}))};
}
