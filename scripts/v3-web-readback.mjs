// V3-only Eagle readback adapter: Web API V2 metadata + independently verified local file path.
// V2's original MCP pathway remains unchanged. All item operations here are read-only.
import {eagleArchiveRpc} from './eagle-archive.mjs';
import {physicalImagePath} from './v3-fingerprint.mjs';
import {requestEagle} from './eagle-request.mjs';
export async function v3WebReadItems({baseUrl='http://127.0.0.1:41595',fetchFn=fetch,
  query={},libraryPath}={}){
  if(!libraryPath)throw Error('Missing Eagle library path');
  const result=await requestEagle({endpoint:new URL('/api/v2/item/get',baseUrl),operation:'item_get',
    timeoutMs:30000,fetchFn,options:{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({...query,limit:Number(query.limit||250),offset:Number(query.offset||0)})}});
  if(result.status!=='success'||!Array.isArray(result.data?.data))
    throw Error('Eagle V2 readback malformed');
  const rows=result.data.data;
  return rows.map(row=>{
    const physical=physicalImagePath(libraryPath,row);
    return {...row,filePath:physical?.filePath||null};
  });
}
export function createV3ReadbackRpc({eagleMcpUrl,libraryPath,baseUrl='http://127.0.0.1:41595'}={}){
  if(!eagleMcpUrl||!libraryPath)throw Error('Invalid V3 readback configuration');
  return async(name,args={})=>{
    if(name==='item_get')return v3WebReadItems({baseUrl,libraryPath,query:args});
    return eagleArchiveRpc(eagleMcpUrl,name,args,name==='item_add'?90000:45000);
  };
}
