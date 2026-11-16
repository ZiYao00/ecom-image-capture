// Shared, executable policy. Historical notes are not an execution authority.
import {resolve} from 'node:path';

export const DIRECT_FALLBACK_LIMIT = 10;

export function resolveOutputRoot(projectRoot, explicit, configured, environment=process.env) {
  const selected = explicit || environment.ECOM_OUTPUT_ROOT || configured || 'output';
  if(typeof selected!=='string' || !selected.trim()) throw Error('Invalid output root');
  return resolve(projectRoot,selected);
}
export function enforceDirectFallback(receipt, newNames) {
  if (!receipt || !Array.isArray(receipt.images) || !Array.isArray(newNames))
    throw Error('Fallback requires a receipt and an array of image names');
  if (!['partially_verified'].includes(receipt.eagle))
    throw Error('Direct fallback requires a finished, partially verified Eagle batch');
  const expected=new Set(receipt.images.filter(x=>x.verified!==true).map(x=>x.name));
  const already=new Set((receipt.directFallback||[]).map(x=>x.name));
  const requested=new Set(newNames);
  if(requested.size!==newNames.length)throw Error('Duplicate fallback image requested');
  for(const name of requested){
    if(typeof name!=='string'||!expected.has(name))throw Error('Fallback image not in unverified Eagle records: '+name);
  }
  const total=new Set([...already,...requested]);
  if(total.size>DIRECT_FALLBACK_LIMIT)
    throw Error('Direct fallback limit exceeded: '+total.size+'/'+DIRECT_FALLBACK_LIMIT);
  return {limit:DIRECT_FALLBACK_LIMIT,previous:already.size,requested:requested.size,remaining:DIRECT_FALLBACK_LIMIT-total.size};
}
export function readbackNeedsRetry(verification) {
  return !!verification && (
    verification.records?.some(item=>item.verified!==true) ||
    (verification.issues||[]).length>0
  );
}
