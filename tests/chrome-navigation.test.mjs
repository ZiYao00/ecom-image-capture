import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateInNavigatedTab,isNavigationContextRace} from '../scripts/chrome-navigation.mjs';
test('only transient Chrome destroyed context errors are retried in same tab',async()=>{
 let runs=0,retries=0;
 const res=await evaluateInNavigatedTab(async()=>{
  runs++;
  if(runs<3)throw Error('evaluate_script: Execution context was destroyed, most likely because of a navigation.');
  return {host:'detail.tmall.com',items:12};
 },{delays:[0,0],wait:async()=>{},onRetry:()=>retries++});
 assert.equal(runs,3);assert.equal(retries,2);
 assert.equal(res.items,12);
});
test('does not retry other Chrome errors or beyond the bounded limit',async()=>{
 let runs=0;
 await assert.rejects(evaluateInNavigatedTab(async()=>{
  runs++;throw Error('Captcha/login needed');
 },{delays:[0],wait:async()=>{}}),/Captcha/);
 assert.equal(runs,1);
 runs=0;
 await assert.rejects(evaluateInNavigatedTab(async()=>{
  runs++;throw Error('Execution context was destroyed');
 },{delays:[0,0],wait:async()=>{}}),/destroyed/);
 assert.equal(runs,3);
 assert.equal(isNavigationContextRace(Error('Chrome target closed')),false);
});
