import test from 'node:test';
import assert from 'node:assert/strict';
import {repairCopyState,uniqueExactMatches,applyRecovered} from '../scripts/recovery-core.mjs';
test('copy-only never converts uncertain Eagle receipt to success',()=>{
 const r={eagle:'uncertain_no_retry',images:[{verified:true,itemId:'A',filePath:'C:/a'}],errors:[]};
 assert.equal(repairCopyState(r,{copied:1,errors:[],destination:'C:/out'}).phase,'incomplete');
});
test('fully verified copy can succeed',()=>{
 const r={eagle:'verified',images:[{verified:true,itemId:'A',filePath:'C:/a'}],errors:[]};
 assert.equal(repairCopyState(r,{copied:1,errors:[],destination:'C:/out'}).phase,'success');
});
test('no copy result can hide an incomplete Eagle result',()=>{
 const r={eagle:'partially_verified',images:[{verified:false}],errors:[]};
 assert.equal(repairCopyState(r,{copied:1,errors:[],destination:'C:/out'}).phase,'incomplete');
});
test('ambiguous exact-name matches are not recovered',()=>{
 const expect=[{name:'Tmall-A-main-001'}],item={id:'a',name:expect[0].name,width:800,height:800,filePath:'C:/a'};
 const result=uniqueExactMatches(expect,[item,{...item,id:'b'}]);
 assert.equal(result.matches.size,0);
 assert.equal(result.issues.length,1);
});
test('known exact item can be recovered without submitting',()=>{
 const receipt={eagle:'uncertain_no_retry',images:[{name:'A',verified:false},{name:'B',verified:true}]};
 const m={id:'I',name:'A',filePath:'C:/a.jpg',width:800,height:1000};
 const {matches,issues}=uniqueExactMatches([{name:'A'}],[m]);
 assert.deepEqual(issues,[]);
 const result=applyRecovered(receipt,matches);
 assert.equal(result.eagle,'verified');
 assert.equal(result.images[0].itemId,'I');
 assert.equal(receipt.images[0].verified,false);
});
