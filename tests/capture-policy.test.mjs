import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {resolveOutputRoot,enforceDirectFallback,DIRECT_FALLBACK_LIMIT} from '../scripts/capture-policy.mjs';

test('output precedence: explicit > environment > per-machine config > project output',()=>{
 const root=resolve('C:/Example/ecom');
 assert.equal(resolveOutputRoot(root,undefined,undefined,{}),resolve(root,'output'));
 assert.equal(resolveOutputRoot(root,undefined,'custom',{}),resolve(root,'custom'));
 assert.equal(resolveOutputRoot(root,undefined,'custom',{ECOM_OUTPUT_ROOT:'env'}),resolve(root,'env'));
 assert.equal(resolveOutputRoot(root,'explicit','custom',{ECOM_OUTPUT_ROOT:'env'}),resolve(root,'explicit'));
});
test('direct fallback is never a primary downloader and accepts <=10 distinct unverified assets',()=>{
 const make=n=>({eagle:'partially_verified',images:Array.from({length:n},(_,i)=>({name:'detail-'+i}))});
 assert.equal(DIRECT_FALLBACK_LIMIT,10);
 assert.equal(enforceDirectFallback(make(10),make(10).images.map(x=>x.name)).remaining,0);
 assert.throws(()=>enforceDirectFallback(make(11),make(11).images.map(x=>x.name)),/limit exceeded/);
 assert.throws(()=>enforceDirectFallback({...make(1),eagle:'not_called'},['detail-0']),/partially verified/);
 assert.throws(()=>enforceDirectFallback({...make(1),eagle:'uncertain_no_retry'},['detail-0']),/partially verified/);
 assert.throws(()=>enforceDirectFallback(make(1),['detail-0','detail-0']),/Duplicate/);
 assert.throws(()=>enforceDirectFallback(make(1),['unknown']),/not in unverified/);
});
test('fallback budget remains cumulative across restarts',()=>{
 const receipt={eagle:'partially_verified',
   images:Array.from({length:11},(_,i)=>({name:'detail-'+i})),
   directFallback:Array.from({length:8},(_,i)=>({name:'detail-'+i}))};
 assert.equal(enforceDirectFallback(receipt,['detail-8','detail-9']).remaining,0);
 assert.throws(()=>enforceDirectFallback(receipt,['detail-8','detail-9','detail-10']),/limit exceeded/);
});
