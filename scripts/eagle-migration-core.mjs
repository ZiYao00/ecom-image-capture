// Legacy dated-root consolidation only. Industry nesting is treated as already
// consolidated and MUST NEVER be flattened back into the batch archive root.
import {ECOM_ARCHIVE_ROOT} from './eagle-archive.mjs';
import {industryCodeOfFolder,productFolderName} from './eagle-folder-layout.mjs';
const legacy=name=>/^天猫批量采集_\d{4}-\d{2}-\d{2}$/.test(String(name));
export function planUnifiedFolderMigration(roots){
  if(!Array.isArray(roots))throw Error('Unexpected Eagle folder tree');
  const unified=roots.filter(x=>x.name===ECOM_ARCHIVE_ROOT);
  if(unified.length>1)throw Error('Duplicate unified Eagle roots');
  const historic=roots.filter(x=>legacy(x.name));
  if(!historic.length&&!unified.length)
    return{status:'nothing_to_migrate',rootName:ECOM_ARCHIVE_ROOT,anchor:null,
      target:null,move:[],products:[],legacyRoots:[]};
  const anchor=unified[0]||historic.toSorted((a,b)=>(b.children||[]).length-(a.children||[]).length)[0];
  if(!anchor?.id)throw Error('Invalid migration anchor');
  const seenIds=new Set(),seenNames=new Set(),products=[];
  const add=(root,folder,parentId,nested=false)=>{
    if(!productFolderName(folder.name)||!folder.id)
      throw Error('Unexpected non-product child in batch root '+root.name+': '+folder.name);
    if(seenNames.has(folder.name))throw Error('Conflicting product folders: '+folder.name);
    seenNames.add(folder.name);
    const children=folder.children||[],matching=name=>children.filter(x=>x.name===name);
    if(matching('主图').length!==1||matching('详情页').length!==1)
      throw Error('Product has missing/ambiguous category folders: '+folder.name);
    products.push({name:folder.name,id:folder.id,sourceRootId:root.id,
      sourceRootName:root.name,parentId,nested,
      mainFolderId:matching('主图')[0].id,detailFolderId:matching('详情页')[0].id});
  };
  for(const root of [...historic,...unified]){
    if(!root?.id||seenIds.has(root.id))throw Error('Invalid/duplicate root ID');
    seenIds.add(root.id);
    for(const folder of root.children||[]){
      if(productFolderName(folder.name)){
        add(root,folder,root.id);continue;
      }
      const category=industryCodeOfFolder(folder.name);
      if(root.name!==ECOM_ARCHIVE_ROOT||category===undefined||!folder.id)
        throw Error('Unexpected non-product child in batch root '+root.name+': '+folder.name);
      for(const nested of folder.children||[])add(root,nested,folder.id,true);
    }
  }
  return{
    status:anchor.name===ECOM_ARCHIVE_ROOT&&products.every(x=>x.sourceRootId===anchor.id)
      ?'already_unified':'ready',
    rootName:ECOM_ARCHIVE_ROOT,
    anchor:{id:anchor.id,name:anchor.name,rename:anchor.name!==ECOM_ARCHIVE_ROOT},
    target:{id:anchor.id,name:ECOM_ARCHIVE_ROOT},
    move:products.filter(x=>x.sourceRootId!==anchor.id),
    products,legacyRoots:historic.map(x=>({id:x.id,name:x.name,
      productCount:(x.children||[]).length}))
  };
}
