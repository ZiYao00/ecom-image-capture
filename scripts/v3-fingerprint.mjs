// V3.1 exact-byte Eagle image index. This module never changes an Eagle library.
import {createReadStream,existsSync,readFileSync,realpathSync,statSync,mkdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {requestEagle} from './eagle-request.mjs';

export const SUPPORTED_IMAGE_EXTENSIONS = new Set(['jpg','jpeg','png','gif','webp']);
export const defaultWebApi = 'http://127.0.0.1:41595';

export function imageItem(item) {
  return !!(item&&typeof item.id==='string'&&/^[A-Za-z0-9_-]{8,64}$/.test(item.id)&&
    SUPPORTED_IMAGE_EXTENSIONS.has(String(item.ext||'').toLowerCase())&&item.isDeleted!==true);
}

export async function visibleEagleItemCount({baseUrl=defaultWebApi,fetchFn=fetch}={}){
  const endpoint=new URL('/api/v2/item/get',baseUrl);
  endpoint.searchParams.set('limit','1');
  endpoint.searchParams.set('offset','0');
  const data=await requestEagle({endpoint,operation:'item_get',timeoutMs:12000,fetchFn});
  if(data.status!=='success'||!Number.isInteger(data.data?.total)||!Array.isArray(data.data?.data))
    throw Error('Eagle visible-items count malformed');
  return data.data.total;
}

export async function listWebApiItems({baseUrl=defaultWebApi,fetchFn=fetch,pageSize=200,maxItems=200000}={}) {
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>1000)throw Error('Invalid Eagle page size');
  const result=[],ids=new Set();
  let total=null;
  for(let offset=0;offset<maxItems;offset+=pageSize) {
    const uri=new URL('/api/v2/item/get',baseUrl);
    uri.searchParams.set('offset',String(offset));uri.searchParams.set('limit',String(pageSize));
    const parsed=await requestEagle({endpoint:uri,operation:'item_get',timeoutMs:30000,fetchFn}),body=parsed?.data;
    const rows=body?.data;
    if(parsed.status!=='success'||!Array.isArray(rows)||!Number.isInteger(body.total))
      throw Error('Eagle Web API malformed item page');
    if(total===null)total=body.total;
    else if(body.total!==total)throw Error('Eagle library changed during enumeration; retry only read-only enumeration');
    for(const item of rows){
      if(!item||typeof item.id!=='string'||ids.has(item.id))throw Error('Duplicate/invalid Eagle item during enumeration');
      ids.add(item.id);result.push(item);
    }
    if(result.length>maxItems)throw Error('Eagle library exceeds indexing safety cap');
    if(rows.length<pageSize)break;
  }
  if(result.length!==total)throw Error('Incomplete Eagle enumeration: received '+result.length+' of '+total);
  return {total,items:result};
}

export function physicalImagePath(libraryPath,item) {
  if(!imageItem(item))return null;
  const id=item.id,library=resolve(libraryPath),folder=join(library,'images',id+'.info');
  const metaPath=join(folder,'metadata.json');
  if(!existsSync(metaPath))return null;
  const meta=JSON.parse(readFileSync(metaPath,'utf8'));
  if(meta.id!==id||meta.isDeleted===true||!SUPPORTED_IMAGE_EXTENSIONS.has(String(meta.ext||'').toLowerCase())||
     !Number.isInteger(meta.width)||meta.width<=0||!Number.isInteger(meta.height)||meta.height<=0||
     meta.width!==item.width||meta.height!==item.height||
     !/^[^\\/\0]+$/.test(String(meta.name||'')))return null;
  const file=join(folder,meta.name+'.'+meta.ext);
  if(!existsSync(file))return null;
  const real=realpathSync(file);
  if(!real.toLowerCase().replaceAll('\\','/').includes('/images/'+id.toLowerCase()+'.info/'))return null;
  const st=statSync(real);
  if(!st.isFile()||!st.size)return null;
  return {filePath:real,bytes:st.size,ext:meta.ext.toLowerCase(),width:meta.width,height:meta.height,name:meta.name};
}

export async function sha256File(path){
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(path))hash.update(chunk);
  return hash.digest('hex');
}

// Include the physical identity and change timestamps, not only item count.
// A previous schema row without this signature is deliberately rehashed once.
export function physicalSignature(physical){
  const st=statSync(physical.filePath);
  return JSON.stringify([physical.name,physical.ext,physical.width,physical.height,
    st.size,st.mtimeMs,st.ctimeMs,st.birthtimeMs,st.dev,st.ino]);
}
export async function inspectIndexedItem(libraryPath,item) {
  const physical=physicalImagePath(libraryPath,item);
  if(!physical)return null;
  const signature=physicalSignature(physical),sha256=await sha256File(physical.filePath);
  const after=physicalImagePath(libraryPath,item);
  if(!after||after.filePath!==physical.filePath||physicalSignature(after)!==signature)
    throw Error('Image changed during fingerprint hashing: '+item.id);
  return {id:item.id,sha256,size:physical.bytes,
    ext:physical.ext,width:physical.width,height:physical.height,
    name:physical.name,mtime:statSync(physical.filePath).mtimeMs,signature,
    folders:Array.isArray(item.folders)?item.folders:[],filePath:physical.filePath};
}

export async function makeIndexRows(libraryPath,items,{maxInspect=null,onProgress=null,previousRows=[]}={}) {
  const rows=[],invalid=[],skipped=[];
  const previous=new Map(previousRows.map(x=>[x.id,x]));
  let reused=0,hashed=0;
  const eligible=items.filter(imageItem);
  const selected=Number.isInteger(maxInspect)?eligible.slice(0,maxInspect):eligible;
  const eligibleIds=new Set(eligible.map(x=>x.id));
  for(let index=0;index<selected.length;index++){
    const item=selected[index];
    try{
      const physical=physicalImagePath(libraryPath,item);
      if(!physical){invalid.push(item.id);continue;}
      const old=previous.get(item.id),signature=physicalSignature(physical);
      if(old?.signature===signature&&/^[a-f0-9]{64}$/.test(old.sha256||'')){
        rows.push({...old,name:physical.name,ext:physical.ext,width:physical.width,
          height:physical.height,size:physical.bytes,mtime:statSync(physical.filePath).mtimeMs,
          signature,filePath:physical.filePath,folders:Array.isArray(item.folders)?item.folders:[]});
        reused++;
      }else{
        const row=await inspectIndexedItem(libraryPath,item);
        if(row){rows.push(row);hashed++;}else invalid.push(item.id);
      }
    }catch(error){invalid.push(item.id+': '+String(error.message||error).slice(0,80))}
    if(typeof onProgress==='function'&&(index+1)%100===0)onProgress({inspected:index+1,total:selected.length});
  }
  return {rows,invalid,skipped:items.length-eligible.length,inspected:selected.length,eligible:eligible.length,
    reused,hashed,removed:previousRows.filter(x=>!eligibleIds.has(x.id)).length};
}

export async function openFingerprintDatabase(file,{libraryPath}={}) {
  if(Number(process.versions.node.split('.')[0])<24)
    throw Error('V3 fingerprint index requires Node >=24; V2 capture remains available with Node >=20.19');
  const {DatabaseSync}=await import('node:sqlite');
  mkdirSync(resolve(file,'..'),{recursive:true});
  const db=new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS images (item_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL, ext TEXT NOT NULL, name TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, mtime REAL NOT NULL, folders TEXT NOT NULL, generation TEXT NOT NULL)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_v3_images_hash ON images(sha256, generation)');
  if(!db.prepare('PRAGMA table_info(images)').all().some(x=>x.name==='signature'))
    db.exec('ALTER TABLE images ADD COLUMN signature TEXT');
  const stored=db.prepare('SELECT value FROM meta WHERE key=?').get('libraryPath')?.value;
  if(stored&&libraryPath&&stored.toLowerCase()!==resolve(libraryPath).toLowerCase()){
    db.close();throw Error('V3 index is bound to a different Eagle library');
  }
  return {
    db,
    close:()=>db.close(),
    info:()=>Object.fromEntries(db.prepare('SELECT key,value FROM meta').all().map(x=>[x.key,x.value])),
    inventory:()=>{
      const generation=db.prepare('SELECT value FROM meta WHERE key=?').get('activeGeneration')?.value;
      return generation?db.prepare('SELECT item_id AS id,sha256,size,ext,name,width,height,mtime,folders,signature FROM images WHERE generation=? ORDER BY item_id').all(generation).map(x=>({...x,folders:JSON.parse(x.folders)})):[];
    },
    lookup:(sha256)=>{
      const generation=db.prepare('SELECT value FROM meta WHERE key=?').get('activeGeneration')?.value;
      if(!generation||!/^[a-f0-9]{64}$/.test(sha256))return [];
      return db.prepare('SELECT item_id AS id,sha256,size,ext,name,width,height,mtime,folders FROM images WHERE sha256=? AND generation=? ORDER BY item_id').all(sha256,generation).map(x=>({...x,folders:JSON.parse(x.folders)}));
    },
    setLibraryItemTotal:(count)=>{
      if(!Number.isInteger(count)||count<0)throw Error('Invalid Eagle library count');
      db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('libraryItemTotal',String(count));
    },
    upsertVerified:(row)=>{
      const generation=db.prepare('SELECT value FROM meta WHERE key=?').get('activeGeneration')?.value;
      if(!generation||!/^[a-f0-9]{64}$/.test(row?.sha256||'')||!row.id)
        throw Error('Cannot add unverified image to V3 index');
      const stmt=db.prepare('INSERT INTO images(item_id,sha256,size,ext,name,width,height,mtime,folders,generation,signature) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET sha256=excluded.sha256,size=excluded.size,ext=excluded.ext,name=excluded.name,width=excluded.width,height=excluded.height,mtime=excluded.mtime,folders=excluded.folders,generation=excluded.generation,signature=excluded.signature');
      stmt.run(row.id,row.sha256,row.size,row.ext,row.name,row.width,row.height,row.mtime,JSON.stringify(row.folders||[]),generation,row.signature||null);
    },
    writeGeneration:(rows,{libraryItemTotal=null}={})=>{
      const generation=randomUUID();
      const insert=db.prepare('INSERT INTO images(item_id,sha256,size,ext,name,width,height,mtime,folders,generation,signature) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET sha256=excluded.sha256,size=excluded.size,ext=excluded.ext,name=excluded.name,width=excluded.width,height=excluded.height,mtime=excluded.mtime,folders=excluded.folders,generation=excluded.generation,signature=excluded.signature');
      const meta=db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      db.exec('BEGIN IMMEDIATE');
      try{
        for(const row of rows)insert.run(row.id,row.sha256,row.size,row.ext,row.name,row.width,row.height,row.mtime,JSON.stringify(row.folders),generation,row.signature||null);
        if(libraryPath)meta.run('libraryPath',resolve(libraryPath));
        meta.run('activeGeneration',generation);
        meta.run('indexedCount',String(rows.length));
        meta.run('indexedAt',new Date().toISOString());
        if(Number.isInteger(libraryItemTotal))meta.run('libraryItemTotal',String(libraryItemTotal));
        db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e}
      return generation;
    }
  };
}

// Detect equal-count replacement and physical changes before a new write phase.
// Existing exact hash candidates are still independently re-read before reuse.
export async function assertFingerprintInventory(index,libraryPath,{listItems=listWebApiItems}={}){
  const info=index.info(),live=await listItems();
  const indexed=new Map(index.inventory().map(x=>[x.id,x]));
  const eligible=live.items.filter(imageItem);
  if(live.total!==Number(info.libraryItemTotal)||indexed.size!==eligible.length)
    throw Error('Eagle inventory differs from active fingerprint generation; rebuild before writes');
  for(const item of eligible){
    const row=indexed.get(item.id),physical=physicalImagePath(libraryPath,item);
    if(!row||!physical||!row.signature||physicalSignature(physical)!==row.signature)
      throw Error('Eagle inventory identity or physical metadata changed: '+item.id+'; rebuild before writes');
  }
  return {status:'current',total:live.total,eligible:eligible.length};
}

// Compare the complete inventory twice before activating a new generation.
// Incremental reuse is based on unchanged physical identity; every exact hash
// candidate is still independently rehashed before reuse in the import path.
export async function refreshFingerprintIndex(index,libraryPath,{listItems=listWebApiItems,full=false,attempts=2}={}){
  if(!Number.isInteger(attempts)||attempts<1||attempts>3)throw Error('Invalid refresh attempt bound');
  let failure;
  for(let attempt=1;attempt<=attempts;attempt++){
    try{
      const first=await listItems();
      const inspected=await makeIndexRows(libraryPath,first.items,{previousRows:full?[]:index.inventory()});
      if(inspected.invalid.length)throw Error('Eagle image sources unavailable: '+inspected.invalid.slice(0,5).join(','));
      const last=await listItems(),byId=new Map(inspected.rows.map(x=>[x.id,x]));
      const firstIds=new Set(first.items.map(x=>x.id));
      if(first.total!==last.total||firstIds.size!==last.items.length||
         last.items.some(x=>!firstIds.has(x.id))||last.items.filter(imageItem).length!==byId.size)
        throw Error('Eagle inventory changed during fingerprint refresh');
      for(const item of last.items.filter(imageItem)){
        const row=byId.get(item.id),physical=physicalImagePath(libraryPath,item);
        if(!row||!physical||physicalSignature(physical)!==row.signature)
          throw Error('Eagle physical inventory changed during fingerprint refresh: '+item.id);
        row.folders=Array.isArray(item.folders)?item.folders:[];
      }
      const generation=index.writeGeneration(inspected.rows,{libraryItemTotal:last.total});
      return {status:'index_ready',generation,libraryItemTotal:last.total,indexable:inspected.rows.length,
        imageEligible:inspected.eligible,inspected:inspected.inspected,unavailableCount:0,unavailable:[],
        ignoredNonImages:inspected.skipped,reused:inspected.reused,hashed:inspected.hashed,
        removed:inspected.removed,attempts:attempt,dbModified:true};
    }catch(error){failure=error;
      // Only retry read-only inventory drift. A database write or source failure
      // is not automatically repeated, and no incomplete generation is published.
      if(!/inventory changed|changed during enumeration|changed during fingerprint refresh/i.test(String(error.message||error)))throw error;
    }
  }
  throw failure;
}

export async function syncV3StitchPartsToIndex({indexPath,libraryPath,parts,getById,getLiveCount}={}){
  if(!Array.isArray(parts)||!parts.length)return {status:'nothing_to_sync',count:0};
  if(typeof getById!=='function'||typeof getLiveCount!=='function')
    throw Error('V3 index synchronization needs current Eagle readers');
  const db=await openFingerprintDatabase(indexPath,{libraryPath});
  try{
    const prior=Number(db.info().libraryItemTotal);
    if(!Number.isInteger(prior)||prior<0)throw Error('Unknown pre-stitch library count');
    const rows=[];
    for(const part of parts){
      if(!part?.id||!/^[a-f0-9]{64}$/.test(part.sha256||''))
        throw Error('Stitch source proof invalid');
      const item=await getById(part.id);
      const record=item&&await inspectIndexedItem(libraryPath,item);
      if(!record||record.sha256!==part.sha256||record.width!==part.width||
         record.height!==part.height)
        throw Error('Stitch item physical proof is not verifiable: '+part.id);
      rows.push(record);
    }
    const unique=new Set(rows.map(x=>x.id));
    if(unique.size!==rows.length)throw Error('Duplicate stitch IDs');
    const added=rows.filter(row=>!db.lookup(row.sha256).some(x=>x.id===row.id));
    const actual=await getLiveCount();
    if(actual!==prior+added.length)
      throw Error('Eagle library count changed outside the verified stitch items');
    for(const row of rows)db.upsertVerified(row);
    db.setLibraryItemTotal(actual);
    return {status:'synced',count:rows.length,added:added.length,libraryTotal:actual};
  }finally{db.close()}
}

export function chooseExactMatch(candidates,folderId) {
  if(!Array.isArray(candidates)||!candidates.length)return null;
  const verified=candidates.filter(x=>x&&x.verified===true&&/^[a-f0-9]{64}$/.test(x.sha256||''));
  if(!verified.length)return null;
  verified.sort((a,b)=>Number((b.folders||[]).includes(folderId))-Number((a.folders||[]).includes(folderId))||
    a.id.localeCompare(b.id));
  return verified[0];
}
