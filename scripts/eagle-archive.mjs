// Eagle classification is a separate, readback-verified stage after item_add.
import {statSync} from 'node:fs';
import {requestEagle} from './eagle-request.mjs';
import {locateEagleProductFolder,industryFolderName,isEcomRootName} from './eagle-folder-layout.mjs';
const physicalFileExists=path=>{try{const s=statSync(path);return s.isFile()&&s.size>0}catch{return false}};
// This module NEVER calls item_add and NEVER deletes or moves existing items.
export const ECOM_ARCHIVE_ROOT = '电商平台批量采集';
export const isSupportedArchiveRoot = isEcomRootName;
export function archiveRootForDate(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return '天猫批量采集_' + [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-');
}

export function archiveImageCategory(record) {
  if (!record || !['main', 'detail'].includes(record.category)) throw Error('Unexpected capture image category');
  return record.category;
}

export async function eagleArchiveRpc(endpoint, name, args = {}, timeoutMs = 45000) {
  const raw = await requestEagle({endpoint,operation:name,timeoutMs,bodyType:'text',options:{
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1097, method: 'tools/call', params: {name, arguments: args}})
  }});
  const line = raw.split(/\r?\n/).find(x => x.startsWith('data:'));
  const value = JSON.parse(line ? line.slice(5).trim() : raw);
  if (value.error || value.result?.isError) throw Error('Eagle ' + name + ' failed: ' + JSON.stringify(value.error || value.result).slice(0, 400));
  const text = value.result?.content?.find(x => x.type === 'text')?.text;
  if (!text) throw Error('Eagle ' + name + ' returned empty data');
  const payload = JSON.parse(text);
  if (payload.success === false) throw Error('Eagle ' + name + ': ' + String(payload.message || 'reported failure'));
  return payload.data ?? payload;
}

function asArray(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.items)) return result.items;
  if (Array.isArray(result?.folders)) return result.folders;
  throw Error('Unexpected Eagle result collection');
}

function findChildren(tree, parentId) {
  if (parentId === null) return tree;
  for (const node of tree) {
    if (node.id === parentId) return node.children || [];
    const found = findChildren(node.children || [], parentId);
    if (found) return found;
  }
  return null;
}

async function resolveFolder({rpc, name, parentId, apply}) {
  const readTree = async () => asArray(await rpc('folder_get', {getAllHierarchy: true, fullDetails: true}));
  const locate = tree => {
    const siblings = findChildren(tree, parentId);
    if (!siblings) throw Error('Missing Eagle parent folder ' + parentId);
    const matches = siblings.filter(x => x.name === name);
    if (matches.length > 1) throw Error('Duplicate Eagle folder name at same level: ' + name);
    return matches[0] || null;
  };
  let result = locate(await readTree());
  if (result) return {id: result.id, name, created: false};
  if (!apply) return null;
  // A folder creation may succeed even when RPC fails. Never retry on an uncertain result.
  await rpc('folder_create', {folders: [{name, ...(parentId ? {parentId} : {})}]});
  result = locate(await readTree());
  if (!result) throw Error('Eagle folder create returned but folder not verifiable: ' + name);
  return {id: result.id, name, created: true};
}

export async function ensureEagleProductFolders({rpc,productId,rootName=ECOM_ARCHIVE_ROOT,
  apply=true,industryCode=null}){
 if(!/^\d{8,16}$/.test(String(productId))||!isSupportedArchiveRoot(rootName))
  throw Error('Unsafe Eagle product folder request');
 const roots=asArray(await rpc('folder_get',{getAllHierarchy:true,fullDetails:true}));
 const existing=locateEagleProductFolder(roots,productId);
 if(existing&&existing.rootName!==rootName)
   throw Error('Existing Eagle product is in another archive root; resolve before creating: '+productId);
 if(existing){
   const expected=industryFolderName(industryCode);
   if(industryCode&&existing.industryName&&existing.industryName!==expected)
     throw Error('Existing Eagle product industry differs; migrate the folder before import: '+productId);
   const main=await resolveFolder({rpc,name:'主图',parentId:existing.productFolderId,apply});
   const detail=await resolveFolder({rpc,name:'详情页',parentId:existing.productFolderId,apply});
   if(!main||!detail)return null;
   return {root:existing.rootId,industry:existing.parentId===existing.rootId?null:existing.parentId,
     industryCode:existing.industryCode,product:existing.productFolderId,main:main.id,detail:detail.id};
 }
 const root=await resolveFolder({rpc,name:rootName,parentId:null,apply});
 if(!root)return null;
 const industry=await resolveFolder({rpc,name:industryFolderName(industryCode),
   parentId:root.id,apply});
 if(!industry)return null;
 const product=await resolveFolder({rpc,name:String(productId),parentId:industry.id,apply});
 if(!product)return null;
 const main=await resolveFolder({rpc,name:'主图',parentId:product.id,apply});
 const detail=await resolveFolder({rpc,name:'详情页',parentId:product.id,apply});
 if(!main||!detail)return null;
 return {root:root.id,industry:industry.id,industryCode:industryCode||null,
   product:product.id,main:main.id,detail:detail.id};
}
function namesByCategory(images) {
  const seen = new Set();
  for (const im of images) {
    archiveImageCategory(im);
    if (!im.name || seen.has(im.name)) throw Error('Missing or duplicated capture image name');
    seen.add(im.name);
  }
}

export async function archiveEagleProduct({rpc, productId, images, rootName = ECOM_ARCHIVE_ROOT, apply = true,
  industryCode=null,fileExists = physicalFileExists}) {
  if (!/^\d{8,16}$/.test(String(productId))) throw Error('Invalid product ID');
  if (!Array.isArray(images) || !images.length) throw Error('No capture images to archive');
  if (!isSupportedArchiveRoot(rootName)) throw Error('Unsafe/unknown Eagle batch root name');
  namesByCategory(images);
  const verified = images.filter(im => im.verified === true && im.itemId);
  const result = {
    status: 'partial', productId: String(productId), rootName,
    expected: {main: images.filter(x => x.category === 'main').length, detail: images.filter(x => x.category === 'detail').length},
    verified: {main: 0, detail: 0}, classified: {main: 0, detail: 0},
    missing: [], folderIds: null, mode: apply ? 'apply' : 'check'
  };
  const missing = new Set(images.filter(x => !x.verified || !x.itemId).map(x => x.name));
  const actualById = new Map();
  // Exact itemId+name matching: a returned item_add ID alone is NOT evidence of import.
  for (let i = 0; i < verified.length; i += 100) {
    const group = verified.slice(i, i + 100);
    const returned = asArray(await rpc('item_get', {ids: group.map(x => x.itemId), fullDetails: true}));
    for (const im of returned) {
      const id = im.id || im.itemId;
      if (id && !actualById.has(id)) actualById.set(id, im);
      else if (id) throw Error('Duplicate Eagle itemId readback ' + id);
    }
  }
  const accepted = {main: [], detail: []};
  for (const im of verified) {
    const actual = actualById.get(im.itemId);
    if (!actual || !(actual.name===im.name || (im.resolution==='reused' &&
         actual.name===im.eagleName && /^[a-f0-9]{64}$/.test(im.sha256||''))) ||
         !actual.filePath || !fileExists(actual.filePath) ||
        !(actual.width > 0) || !(actual.height > 0) || actual.isDeleted === true) {
      missing.add(im.name);
      continue;
    }
    accepted[im.category].push(actual);
  }
  result.verified.main = accepted.main.length;
  result.verified.detail = accepted.detail.length;
  result.missing = [...missing].sort();
  if (!accepted.main.length && !accepted.detail.length) {
    result.status = 'no_verified_eagle_items';
    return result;
  }
  const folderIds = await ensureEagleProductFolders({rpc,productId,rootName,industryCode,apply});
  if (!folderIds) {
    result.status = 'folders_missing';
    return result;
  }
  result.folderIds = folderIds;
  for (const category of ['main', 'detail']) {
    const items = accepted[category];
    const pending = items.filter(im => !(im.folders || []).includes(folderIds[category]));
    if (apply) for (let i = 0; i < pending.length; i += 100) {
      // Idempotent association API; never use item_add / duplicate originals.
      await rpc('item_add_to_folders', {
        ids: pending.slice(i, i + 100).map(x => x.id || x.itemId), folders: [folderIds[category]]
      });
    }
  }
  const all = [...accepted.main, ...accepted.detail];
  const checked = new Map();
  for (let i = 0; i < all.length; i += 100) {
    const returned = asArray(await rpc('item_get', {ids: all.slice(i, i + 100).map(x => x.id || x.itemId), fullDetails: true}));
    for (const item of returned) checked.set(item.id || item.itemId, item);
  }
  for (const category of ['main', 'detail']) {
    for (const im of accepted[category]) {
      const now = checked.get(im.id || im.itemId);
      if ((now?.name===im.name || (im.resolution==='reused'&&now?.name===im.eagleName)) &&
           fileExists(now.filePath) && (now.folders || []).includes(folderIds[category]))
        result.classified[category]++;
    }
  }
  result.status = result.missing.length === 0 &&
    result.classified.main === result.expected.main && result.classified.detail === result.expected.detail
      ? 'complete' : 'partial';
  return result;
}
