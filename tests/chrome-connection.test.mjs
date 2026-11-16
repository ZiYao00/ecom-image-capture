import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const testsRoot=resolve(fileURLToPath(new URL('..',import.meta.url)),'data','.capture-store-tests');
mkdirSync(testsRoot,{recursive:true});
import {chromeConnection,projectChromeMcpEntry,projectChromePort} from '../scripts/chrome-connection.mjs';

const create=()=>{
 const root=mkdtempSync(join(testsRoot,'ecom-portable-chrome-'));
 const pkg=join(root,'node_modules','chrome-devtools-mcp');
 const cli='out/Default/gen/src/bin/chrome-devtools-mcp.js';
 mkdirSync(join(pkg,'out','Default','gen','src','bin'),{recursive:true});
 writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'chrome-devtools-mcp',bin:{'chrome-devtools-mcp':'./'+cli}}));
 writeFileSync(join(pkg,cli),'// stub');
 return {root,entry:join(pkg,cli)};
};
test('public project mode resolves its own Chrome MCP package, not sibling workspace',()=>{
 const {root,entry}=create();
 try{
  const config={chromeMode:'project',chromeDebugPort:9333};
  const link=chromeConnection(root,config,{});
  assert.equal(link.mode,'project');
  assert.equal(link.entry,entry);
  assert.equal(link.url,'http://127.0.0.1:9333');
  assert.ok(link.args.includes('--browserUrl=http://127.0.0.1:9333'));
 }finally{rmSync(root,{recursive:true,force:true})}
});
test('Chrome MCP missing fails explicitly with installation instructions',()=>{
 const root=mkdtempSync(join(testsRoot,'ecom-mcp-missing-'));
 try{assert.throws(()=>chromeConnection(root,{chromeMode:'project'},{}),/npm ci/)}
 finally{rmSync(root,{recursive:true,force:true})}
});
test('Chrome port must be a non-privileged local TCP port',()=>{
 assert.equal(projectChromePort({},{}),9222);
 assert.equal(projectChromePort({chromeDebugPort:9500},{}),9500);
 assert.throws(()=>projectChromePort({chromeDebugPort:0},{}),/Invalid/);
 assert.throws(()=>projectChromePort({chromeDebugPort:65536},{}),/Invalid/);
});
test('official autoConnect mode also uses project-local MCP entry',()=>{
 const {root,entry}=create();
 try{
  const link=chromeConnection(root,{chromeMode:'autoConnect'},{});
  assert.equal(link.entry,entry);
  assert.ok(link.args.includes('--autoConnect'));
 }finally{rmSync(root,{recursive:true,force:true})}
});
