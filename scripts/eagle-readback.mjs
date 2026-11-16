// Read-only, bounded Eagle item_get retries. Never submits or re-submits item_add.
import {reconcileEagleItems} from './eagle-reconcile.mjs';
import {readbackNeedsRetry} from './capture-policy.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function verifyEagleReadback(expected,added,readDetails,{delays=[400,900,1800],wait=sleep}={}){
  if(!Array.isArray(expected)||!Array.isArray(added)||typeof readDetails!=='function')
    throw Error('Invalid Eagle readback arguments');
  const ids=[...new Set(added.map(x=>x?.itemId||x?.id).filter(Boolean))];
  let result=null,attempts=0;
  for(let i=0;i<=delays.length;i++){
    attempts++;
    const data=ids.length?await readDetails(ids):[];
    const rows=Array.isArray(data)?data:(data?.items||[]);
    result=reconcileEagleItems(expected,added,rows);
    if(!readbackNeedsRetry(result))break;
    const conflicts=result.issues.some(x=>/duplicate name|disagree|unknown\/invalid|unexpected name/i.test(x));
    if(conflicts||i===delays.length)break;
    await wait(delays[i]);
  }
  return {...result,attempts,submittedIds:ids};
}
