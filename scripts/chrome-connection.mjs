// Chrome MCP adapter: portable project mode by default; legacy shared mode preserved.
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';

export function projectChromeMcpEntry(root,config={},env=process.env) {
  if(env.CHROME_MCP_ENTRY || config.chromeMcpEntry) {
    const configured=resolve(root,env.CHROME_MCP_ENTRY||config.chromeMcpEntry);
    if(existsSync(configured))return configured;
    // The example template no longer includes a placeholder. A stale configuration is an error.
    throw Error('Configured Chrome MCP entry not found: '+configured);
  }
  const pkgFile=join(root,'node_modules','chrome-devtools-mcp','package.json');
  if(!existsSync(pkgFile))throw Error('Project Chrome DevTools MCP missing; run npm ci in the project root');
  const pkg=JSON.parse(readFileSync(pkgFile,'utf8'));
  const binary=pkg.bin?.['chrome-devtools-mcp'];
  if(!binary)throw Error('Installed Chrome MCP package has no chrome-devtools-mcp bin');
  const entry=resolve(dirname(pkgFile),binary);
  if(!existsSync(entry))throw Error('Chrome MCP binary not found: '+entry);
  return entry;
}
export function projectChromePort(config={},env=process.env){
  const raw=env.ECOM_CHROME_DEBUG_PORT??config.chromeDebugPort??9222;
  const port=Number(raw);
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid local Chrome debug port');
  return port;
}
export function chromeConnection(root,localConfig={},env=process.env){
  const mode=env.CHROME_CONNECTION_MODE||localConfig.chromeMode||'project';
  const flags=['--no-usage-statistics','--no-performance-crux'];
  if(mode==='project'){
    const entry=projectChromeMcpEntry(root,localConfig,env);
    const port=projectChromePort(localConfig,env);
    const url='http://127.0.0.1:'+port;
    return {mode,entry,args:[entry,'--browserUrl='+url,...flags],url};
  }
  if(mode==='autoConnect'){
    const entry=projectChromeMcpEntry(root,localConfig,env);
    return {mode,entry,args:[entry,'--autoConnect',...flags]};
  }
  if(mode!=='shared')throw Error('Unsupported Chrome connection mode: '+mode);
  const file=resolve(root,localConfig.chromeAgentSettings||'../local-service-control/chrome-agent/config/settings.json');
  if(!existsSync(file))throw Error('Shared Chrome Agent settings missing (legacy mode); use chromeMode=project for public installs');
  const settings=JSON.parse(readFileSync(file,'utf8'));
  if(settings.host!=='127.0.0.1'||!Number.isInteger(settings.port)||settings.port<1024||settings.port>65535)
    throw Error('Shared Chrome must use a valid 127.0.0.1 TCP port');
  const agentRoot=resolve(dirname(file),'..');
  const entry=env.CHROME_MCP_ENTRY||resolve(agentRoot,settings.chromeMcpEntryRelative);
  if(!existsSync(entry))throw Error('Shared Chrome MCP entry missing: '+entry);
  const url='http://'+settings.host+':'+settings.port;
  return {mode,entry,args:[entry,'--browserUrl='+url,...flags],url};
}
