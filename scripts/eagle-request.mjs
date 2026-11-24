// Retry only known Eagle read operations. Mutations are always single-attempt.
const READ_MCP=new Set(['get_app_info','item_get','folder_get','tag_get','smartfolder_get']);
const READ_WEB=new Set(['/api/v2/item/get']);
const transientHttp=new Set([408,429,500,502,503,504]);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const clean=value=>String(value||'').replace(/https?:\/\/[^\s]+/g,'[url]').slice(0,240);
export function isEagleReadOperation(endpoint,operation){
  const url=new URL(endpoint);
  return READ_WEB.has(url.pathname)&&operation==='item_get'||
    url.pathname==='/mcp'&&READ_MCP.has(operation);
}
export function eagleFailureDetails(error){
  const e=error?.eagleRequest;
  return e?{...e}:null;
}
function failure(message,details,cause){
  const error=new Error(message,{cause});
  error.eagleRequest=details;
  return error;
}
export async function requestEagle({endpoint,operation,options={},timeoutMs=30000,
  bodyType='json',fetchFn=fetch,delays=[200,600],sleep=delay}={}){
  const uri=new URL(endpoint);
  if(!['127.0.0.1','localhost','[::1]'].includes(uri.hostname)||!['http:','https:'].includes(uri.protocol))
    throw Error('Eagle request must target loopback');
  const readOnly=isEagleReadOperation(uri,operation);
  const schedule=readOnly?[0,...delays.slice(0,2)]:[0];
  const deadline=Date.now()+timeoutMs;
  let lastError;
  for(let i=0;i<schedule.length;i++){
    if(Date.now()+schedule[i]>=deadline)throw lastError||Error('Eagle request deadline exhausted');
    if(schedule[i])await sleep(schedule[i]);
    const attemptTimeoutMs=Math.max(1,Math.min(deadline-Date.now(),readOnly?Math.ceil(timeoutMs/2):timeoutMs));
    let response,stage='transport';
    const details={operation,route:uri.pathname,readOnly,timeoutMs,attempt:i+1,maxAttempts:schedule.length,stage,attemptTimeoutMs};
    try{
      response=await fetchFn(uri.href,{...options,signal:AbortSignal.timeout(attemptTimeoutMs)});
      if(!response.ok){
        const status=response.status;
        lastError=failure('Eagle '+operation+' HTTP '+status,{...details,stage:'http',status,outcome:readOnly?'read_failed':'write_outcome_unknown'},null);
        if(readOnly&&transientHttp.has(status)&&i+1<schedule.length)continue;
        throw lastError;
      }
      stage='response_body';
      return await response[bodyType]();
    }catch(error){
      if(error.eagleRequest)throw error;
      const isTransient=stage==='transport'&&(error instanceof TypeError||
        ['AbortError','TimeoutError'].includes(error?.name))||
        stage==='response_body'&&(error instanceof TypeError||['AbortError','TimeoutError'].includes(error?.name));
      lastError=failure('Eagle '+operation+' '+stage+': '+clean(error?.message||error),
        {...details,stage,causeName:clean(error?.name),causeCode:clean(error?.cause?.code||error?.code),
          causeMessage:clean(error?.cause?.message),outcome:readOnly?'read_failed':'write_outcome_unknown'},error);
      if(readOnly&&isTransient&&i+1<schedule.length)continue;
      throw lastError;
    }
  }
  throw Error('Eagle read retry budget exhausted');
}
