// One canonical Eagle folder layout resolver for legacy and industry-nested products.
// Pure functions: never create folders, touch items, or mutate the supplied tree.
import {INDUSTRIES,industryLabel} from './industry-core.mjs';
export const ECOM_ROOT_NAME='电商平台批量采集';
export const UNCLASSIFIED_FOLDER_NAME='待分类';
export const productFolderName=name=>/^\d{8,16}$/.test(String(name));
export const isEcomRootName=name=>name===ECOM_ROOT_NAME||
  /^天猫批量采集_\d{4}-\d{2}-\d{2}$/.test(String(name));
export const industryFolderName=code=>Object.hasOwn(INDUSTRIES,code||'')
  ?industryLabel(code):UNCLASSIFIED_FOLDER_NAME;
export function industryCodeOfFolder(name){
  if(name===UNCLASSIFIED_FOLDER_NAME)return null;
  for(const [code,item] of Object.entries(INDUSTRIES))
    if(item.label===name)return code;
  return undefined;
}
function asRoots(roots){
  if(Array.isArray(roots))return roots;
  if(Array.isArray(roots?.folders))return roots.folders;
  throw Error('Unexpected Eagle root folder collection');
}
export function locateEagleProductFolder(roots,productId,{rootName=null}={}){
  if(!productFolderName(productId))throw Error('Invalid product ID for Eagle folder lookup');
  const matches=[];
  for(const root of asRoots(roots)){
    if(!isEcomRootName(root.name))continue;
    if(rootName&&root.name!==rootName&&
      !(root.name===ECOM_ROOT_NAME&&rootName!==ECOM_ROOT_NAME))continue;
    if(!root.id)throw Error('Eagle archive root has no ID');
    for(const direct of root.children||[]){
      const depth=productFolderName(direct.name)?[{node:direct,parentId:root.id,
        industryCode:null,industryName:null}]:
        ((direct.children||[]).filter(child=>child.name===String(productId)).map(node=>{
          const code=industryCodeOfFolder(direct.name);
          if(code===undefined)throw Error('Product in unknown Eagle industry folder: '+direct.name);
          if(!direct.id)throw Error('Eagle industry folder has no ID: '+direct.name);
          return{node,parentId:direct.id,industryCode:code,industryName:direct.name};
        }));
      for(const item of depth){
        if(item.node.name!==String(productId))continue;
        if(!item.node.id)throw Error('Eagle product folder has no ID: '+productId);
        const children=item.node.children||[];
        const category=name=>{
          const found=children.filter(x=>x.name===name);
          if(found.length>1)throw Error('Duplicate Eagle '+name+' folder: '+productId);
          return found[0]||null;
        };
        const main=category('主图'),detail=category('详情页');
        matches.push({rootName:root.name,rootId:root.id,
          productId:String(productId),productFolderId:item.node.id,
          mainFolderId:main?.id||null,detailFolderId:detail?.id||null,
          parentId:item.parentId,industryCode:item.industryCode,
          industryName:item.industryName,
          product:item.node,root});
      }
    }
  }
  if(matches.length>1)
    throw Error('Ambiguous Eagle product folder '+productId+': exists in multiple locations');
  return matches[0]||null;
}
export function inspectIndustryTree(roots,{rootName=ECOM_ROOT_NAME}={}){
  const found=asRoots(roots).filter(x=>x.name===rootName);
  if(found.length!==1||!found[0].id)throw Error('Expected one Eagle industry archive root');
  const root=found[0],products=[],industries=[],unexpected=[];
  const ids=new Set();
  const record=(node,parentId,code,industryName)=>{
    if(!node.id||ids.has(node.name))throw Error('Duplicate or invalid Eagle product folder: '+node.name);
    ids.add(node.name);
    const children=node.children||[];
    const get=name=>children.filter(x=>x.name===name);
    if(get('主图').length!==1||get('详情页').length!==1||
      !get('主图')[0]?.id||!get('详情页')[0]?.id)
      throw Error('Missing or duplicate product image subfolders: '+node.name);
    products.push({productId:node.name,folderId:node.id,parentId,
      industryCode:code,industryName,rootId:root.id,
      mainFolderId:get('主图')[0].id,detailFolderId:get('详情页')[0].id});
  };
  for(const item of root.children||[]){
    if(productFolderName(item.name)){record(item,root.id,null,null);continue;}
    const industry=industryCodeOfFolder(item.name);
    if(industry===undefined){unexpected.push(item.name);continue;}
    if(industries.some(x=>x.name===item.name||x.id===item.id))
      throw Error('Duplicate industry folders: '+item.name);
    industries.push({name:item.name,id:item.id,code:industry,rootId:root.id});
    if(!item.id)throw Error('Industry has no Eagle folder ID: '+item.name);
    for(const product of item.children||[]){
      if(!productFolderName(product.name))throw Error('Unexpected non-product nested in industry: '+product.name);
      record(product,item.id,industry,item.name);
    }
  }
  if(unexpected.length)throw Error('Unknown children of Eagle archive root: '+unexpected.join(', '));
  return{rootId:root.id,rootName:root.name,products,industries};
}
