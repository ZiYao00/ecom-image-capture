#!/usr/bin/env node
// One command surface for humans and Agents. JSON-only results; no implicit Eagle re-import.
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {loopbackPortOccupied} from './browser-port.mjs';
import {parseBatchOptions} from './batch-core.mjs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const command=args.shift()||'help';
const version=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
const emit=(value,code=0)=>{console.log(JSON.stringify({tool:'ecom-image-capture',version,...value},null,2));process.exitCode=code};
const decode=raw=>{try{return JSON.parse(raw)}catch{return null}};
const config=()=>{
 const read=file=>existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
 return {...read(join(root,'config','local.example.json')),...read(join(root,'config','local.json'))};
};
const mode=()=>process.env.CHROME_CONNECTION_MODE||config().chromeMode||'project';
const run=(exe,argv,{timeout=90000,cwd=root}={})=>{
 const child=spawnSync(exe,argv,{
  cwd,windowsHide:true,encoding:'utf8',timeout,maxBuffer:5*1024*1024,
  env:{...process.env,PYTHONIOENCODING:'utf-8'}
 });
 return {ok:!child.error&&child.status===0,code:child.status,
  output:decode((child.stdout||'').trim()),stdout:(child.stdout||'').trim().slice(-4000),
  error:String(child.error?.message||child.stderr||'').trim().slice(-1600)};
};
const node=(script,argv=[],timeout=90000)=>run(process.execPath,[join(root,'scripts',script),...argv],{timeout});
const npm=()=>{
 // Agent shells may omit npm.cmd from PATH even when Node.js includes npm.
 const npmCli=join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js');
 if(existsSync(npmCli))
   return run(process.execPath,[npmCli,'ci','--ignore-scripts','--no-audit','--no-fund'],{timeout:240000});
 // Fixed npm arguments only. No URL or untrusted text is passed to cmd.exe.
 return process.platform==='win32'
  ?run('cmd.exe',['/d','/s','/c','npm ci --ignore-scripts --no-audit --no-fund'],{timeout:240000})
  :run('npm',['ci','--ignore-scripts','--no-audit','--no-fund'],{timeout:240000});
};
const chromeInstalled=()=>{
 const dep=join(root,'node_modules','chrome-devtools-mcp','package.json');
 if(!existsSync(dep))return false;
 try{
  const installed=JSON.parse(readFileSync(dep,'utf8'));
  const required=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).dependencies['chrome-devtools-mcp'];
  return installed.version===required;
 }catch{return false}
};
const action=(id,description,url)=>({id,description,...(url?{url}:{})});
const eagleHint=action('enable_eagle_mcp','Open Eagle and its asset library, install/enable official MCP Server plugin (localhost:41596/mcp)','https://community-cn.eagle.cool/plugin/mcp-server');
const chromeHint=action('open_chrome','Start the project Chrome window and sign in to Tmall through the browser');
const npmHint=action('install_node_dependencies','Run npm ci from the project root; verify Node.js and internet access');
const noRestart=action('inspect_receipt','Inspect the existing product receipt before any resume. Never repeat an uncertain Eagle item_add.');

const init=runSteps=>{
 const steps=[];
 const record=(id,r,detail=null)=>{steps.push({id,status:r.ok?'passed':'failed',...detail,...(!r.ok?{error:r.error||r.stdout}:{}),...(r.output?{result:r.output}:{})});return r.ok};
 return {steps,record};
};
async function setup(checkOnly=false){
 const [major,minor]=process.versions.node.split('.').map(Number);
 if(major<20||(major===20&&minor<19)){
  emit({status:'needs_action',stage:'node_version',message:'Node.js 20.19.0 or newer is required.'},10);return;
 }
 if(process.platform!=='win32'){
  emit({status:'unsupported_platform',stage:'platform',nextActions:[action('windows','Use Windows for the current version')]},2);
  return;
 }
 const {steps,record}=init();
 const selectedMode=mode();
 let freshConfig=false;
 if(!checkOnly){
  if(selectedMode==='shared')steps.push({id:'npm_ci',status:'legacy_external_mode'});
  else if(!chromeInstalled()){
   const install=npm();
   if(!record('npm_ci',install)){emit({status:'failed',stage:'npm_ci',steps,nextActions:[npmHint]},2);return}
  }else steps.push({id:'npm_ci',status:'already_installed'});
  const local=node('setup.mjs');
  if(!record('local_setup',local)){emit({status:'failed',stage:'local_setup',steps,nextActions:[action('inspect_config','Inspect project config and registry; no files were overwritten')]},2);return}
  freshConfig=local.output?.config==='created';
 }else{
  steps.push({id:'npm_ci',status:selectedMode==='shared'?'legacy_external_mode':chromeInstalled()?'already_installed':'missing'});
  const state=node('setup.mjs',['--check']);
  if(!record('local_setup_check',state)){emit({status:'failed',stage:'local_setup_check',steps},2);return}
 }
 if(selectedMode==='project'){
  if(!checkOnly&&freshConfig){
   const localFile=join(root,'config','local.json');
   const current=JSON.parse(readFileSync(localFile,'utf8'));
   const defaultPort=Number(current.chromeDebugPort||9222);
   if((await loopbackPortOccupied(defaultPort)).occupied){
    let selected=null;
    for(let port=9223;port<=9250;port++){
     if(!(await loopbackPortOccupied(port)).occupied){selected=port;break}
    }
    if(selected===null){emit({status:'needs_action',stage:'chrome_port',nextActions:[action('free_port','No free Chrome debug port in 9223..9250; configure chromeDebugPort')]},10);return}
    current.chromeDebugPort=selected;
    writeFileSync(localFile,JSON.stringify(current,null,2)+'\n','utf8');
    steps.push({id:'chrome_port',status:'configured_fresh_only',port:selected});
   }
  }
  const browser=node('browser.mjs',[checkOnly?'status':'start'],45000);
  const browserState=browser.output?.status;
  if(checkOnly)steps.push({id:'browser',status:browserState==='running'?'passed':browserState||'missing'});
  else if(!record('browser',browser)){emit({status:'needs_action',stage:'browser',steps,nextActions:[chromeHint]},10);return}
 }else steps.push({id:'browser',status:'external_mode',mode:selectedMode});
 if(!chromeInstalled()&&selectedMode!=='shared'){
  emit({status:'needs_action',stage:'npm_ci',steps,nextActions:[npmHint]},10);return;
 }
 const probes=node('probe-mcp.mjs',[],90000);
 const report=probes.output||{};
 steps.push({id:'chrome_mcp',status:report.chrome?.status||'failed',
  ...(report.chrome?.reason?{reason:report.chrome.reason}:{})});
 steps.push({id:'eagle_mcp',status:report.eagle?.status||'failed',
  ...(report.eagle?.reason?{reason:report.eagle.reason}:{})});
 const actions=[];
 if(report.chrome?.status!=='passed')actions.push(chromeHint);
 if(report.eagle?.status!=='passed')actions.push(eagleHint);
 emit({status:actions.length?'needs_action':'ready',mode:selectedMode,
   steps,nextActions:actions,
   note:actions.length?'Do not capture until the listed dependencies are ready.':
   'MCPs are reachable. Tmall sign-in and live-image capture have not been verified by setup.'},actions.length?10:0);
}
function doctor(){
 const result=node('check-environment.mjs',[],120000);
 const report=result.output;
 if(!report){emit({status:'failed',stage:'doctor',error:result.error||result.stdout},2);return}
 emit({status:report.readiness?.capture?'ready':'needs_action',report,
  nextActions:report.readiness?.capture?[]:[
   ...(report.checks?.chrome?.status==='passed'?[]:[chromeHint]),
   ...(report.checks?.eagle?.status==='passed'?[]:[eagleHint])
  ]},report.readiness?.capture?0:10);
}
function capture(incoming,{scanOnly=false,resume=false,v3=false}={}){
  if(v3&&(Number(process.versions.node.split('.')[0])<24||config().v3Experimental!==true)){emit({status:'v3_experimental_disabled',message:'Enable v3Experimental only for an approved controlled trial; normal capture remains V2.'},10);return}
 if(!incoming.length||incoming.length>2){emit({status:'invalid_arguments',usage:resume?'ecom resume <productId> [outputRoot]':'ecom capture "<full URL>" [outputRoot]'},2);return}
 const [target,dest]=incoming;
 if(resume&&!/^[0-9]{8,16}$/.test(target||'')){emit({status:'invalid_product_id'},2);return}
 if(!resume){
  try{
   const url=new URL(target);
   if(url.protocol!=='https:'||url.hostname!=='detail.tmall.com'||url.pathname!=='/item.htm'||!/^[0-9]{8,16}$/.test(url.searchParams.get('id')||''))throw Error('invalid');
  }catch{emit({status:'invalid_url',message:'Provide the complete original https://detail.tmall.com/item.htm URL'},2);return}
 }
 if(mode()==='project'){
  const browser=node('browser.mjs',['start'],45000);
  if(!browser.ok){emit({status:'needs_action',stage:'browser',reason:browser.error||browser.stdout,nextActions:[chromeHint]},10);return}
 }
 const verify=node('probe-mcp.mjs',scanOnly?['--chrome-only']:[],90000);
 const report=verify.output;
 if(report?.chrome?.status!=='passed'||(!scanOnly&&report?.eagle?.status!=='passed')){
  emit({status:'needs_action',stage:'mcp',chrome:report?.chrome,eagle:report?.eagle,
   nextActions:[...(report?.chrome?.status==='passed'?[]:[chromeHint]),...(!scanOnly&&report?.eagle?.status!=='passed'?[eagleHint]:[])]},10);
  return;
 }
 const childArgs=resume?['--resume-existing',target,...(dest?[dest]:[])]:
   scanOnly?['--dry-run',target]:v3?['--v3',target,...(dest?[dest]:[])]:[target,...(dest?[dest]:[])];
 const result=node('capture.mjs',childArgs,420000);
 emit({status:result.ok?'completed':'failed_no_automatic_retry',
   operation:resume?'resume':scanOnly?'scan':v3?'capture-v3':'capture',exitCode:result.code,
   result:result.output||result.stdout, ...(result.ok?{}:{error:result.error,nextActions:[noRestart]})},
  result.ok?0:2);
}
function simple(script,argv,{timeout=90000,operation}={}){
 const r=node(script,argv,timeout);
 emit({status:r.ok?'completed':'failed',operation,exitCode:r.code,
  result:r.output||r.stdout,...(r.ok?{}:{error:r.error})},r.ok?0:2);
}
switch(command){
 case 'setup': {
  if(args.length>1||(args.length===1&&args[0]!=='--check'))emit({status:'invalid_arguments',usage:'ecom setup [--check]'},2);
  else await setup(args[0]==='--check');
  break;
 }
 case 'doctor':if(args.length)emit({status:'invalid_arguments',usage:'ecom doctor'},2);else doctor();break;
 case 'capture':capture(args);break;
  case 'capture-v3':capture(args,{v3:true});break;
  case 'v3-resume':if(args.length!==2||!['--check','--apply'].includes(args[0])||!/^[0-9]{8,16}$/.test(args[1]))emit({status:'invalid_arguments',usage:'ecom v3-resume --check|--apply <productId>'},2);
    else simple('v3-resume-no-write.mjs',args,{operation:'v3-resume',timeout:540000});break;
  case 'v3-resume-partial':if(args.length<2||args.length>3||!['--check','--apply'].includes(args[0])||!/^[0-9]{8,16}$/.test(args[1]))emit({status:'invalid_arguments',usage:'ecom v3-resume-partial --check|--apply <productId> [originalTmallUrl]'},2);
    else simple('v3-resume-partial.mjs',args,{operation:'v3-resume-partial',timeout:840000});break;
  case 'v3-index':if(args.length<1||args.length>2||!['--check','--build'].includes(args[0]))emit({status:'invalid_arguments',usage:'ecom v3-index --check [count]|--build'},2);
    else simple('v3-index.mjs',args,{operation:'v3-index',timeout:300000});break;
  case 'v3-prefetch':if(args.length!==2||!['--check','--cache'].includes(args[0])||!/^[0-9]{8,16}$/.test(args[1]))emit({status:'invalid_arguments',usage:'ecom v3-prefetch --check|--cache <existingProductId>'},2);
    else simple('v3-verify-prefetch.mjs',args,{operation:'v3-prefetch',timeout:300000});break;
  case 'source-closeout': {
   const [name,mode,token]=args;
   if(!['AA','BB'].includes(name)||!['--check','--prepare','--apply'].includes(mode)||
      (mode==='--apply'?args.length!==3||!/^[a-f0-9-]{36}$/.test(token||''):args.length!==2))
     emit({status:'invalid_arguments',usage:'ecom source-closeout AA|BB --check|--prepare | --apply <snapshotId>'},2);
   else simple('source-closeout.mjs',args,{operation:'source-closeout',timeout:0});
   break;
  }
  case 'batch': {
   let parsed;try{parsed=parseBatchOptions(args)}catch(e){emit({status:'invalid_arguments',usage:'ecom batch <urls.txt|urls.json> [--check|--apply] [--engine v2|v3]',error:e.message},2);break}
   // The queue owns bounded child operations; a second aggregate timeout could
   // terminate the coordinator while a child still has an unresolved write.
   simple('batch-capture.mjs',[parsed.file,parsed.mode,'--engine',parsed.engine],{operation:'batch',timeout:0});break;
  }
  case 'recover-duplicates':if(args.length!==2||!/^[0-9]{8,16}$/.test(args[0])||
      !['--check','--apply'].includes(args[1]))
    emit({status:'invalid_arguments',usage:'ecom recover-duplicates <productId> --check|--apply'},2);
   else simple('recover-duplicates.mjs',args,{operation:'recover-duplicates',timeout:360000});break;
  case 'map-eagle':if(args.length!==2||!/^[0-9]{8,16}$/.test(args[0])||
      !['--check','--apply'].includes(args[1]))
    emit({status:'invalid_arguments',usage:'ecom map-eagle <productId> --check|--apply'},2);
   else simple('map-eagle-product.mjs',args,{operation:'map-eagle',timeout:180000});break;
  case 'reconcile-reused':if(args.length!==2||!/^[0-9]{8,16}$/.test(args[0])||
      !['--check','--apply'].includes(args[1]))
    emit({status:'invalid_arguments',usage:'ecom reconcile-reused <productId> --check|--apply'},2);
   else simple('reconcile-reused.mjs',args,{operation:'reconcile-reused',timeout:180000});break;
  case 'verify-live':if(args.length!==2||!/^[0-9]{8,16}$/.test(args[0])||
       !['--check','--apply'].includes(args[1]))
    emit({status:'invalid_arguments',usage:'ecom verify-live <productId> --check|--apply'},2);
   else simple('verify-live-product.mjs',args,{operation:'verify-live',timeout:180000});break;
 case 'scan':capture(args,{scanOnly:true});break;
 case 'resume':capture(args,{resume:true});break;
 case 'export':if(args.length!==1||!/^[0-9]{8,16}$/.test(args[0]))emit({status:'invalid_arguments',usage:'ecom export <productId>'},2);
  else simple('capture.mjs',['--copy-only',args[0]],{operation:'export',timeout:180000});break;
 case 'stitch-eagle':if(!args.length||!/^[0-9]{8,16}$/.test(args[0])||args.length>5)
    emit({status:'invalid_arguments',usage:'ecom stitch-eagle <productId> [width] [--date YYYY-MM-DD] [--check]'},2);
   else simple('stitch-eagle.mjs',args,{operation:'stitch-eagle',timeout:480000});break;
 case 'migrate-eagle':if(args.length!==1||!['--check','--apply'].includes(args[0]))
    emit({status:'invalid_arguments',usage:'ecom migrate-eagle --check|--apply'},2);
   else simple('migrate-eagle-folders.mjs',args,{operation:'migrate-eagle',timeout:180000});break;
 case 'recover-eagle':if(args.length!==2||!/^[0-9]{8,16}$/.test(args[0])||
     !['--check','--apply'].includes(args[1]))
    emit({status:'invalid_arguments',usage:'ecom recover-eagle <productId> --check|--apply'},2);
   else simple('recover-eagle-local.mjs',args,{operation:'recover-eagle',timeout:180000});break;
 case 'finish':if(args.length!==1||!/^[0-9]{8,16}$/.test(args[0]))
    emit({status:'invalid_arguments',usage:'ecom finish <productId>'},2);
   else {
     const checked=node('archive-product.mjs',[args[0],'--check'],90000);
     if(!checked.ok)emit({status:'blocked_incomplete_eagle_sources',operation:'finish',
       preflight:checked.output||checked.stdout,error:checked.error},2);
     else simple('stitch-eagle.mjs',[args[0],'750'],{operation:'finish',timeout:480000});
   }break;
 case 'archive':if(!args.length||!/^[0-9]{8,16}$/.test(args[0])||args.length>3)emit({status:'invalid_arguments',usage:'ecom archive <productId> [YYYY-MM-DD] [--check]'},2);
  else simple('archive-product.mjs',args,{operation:'archive',timeout:180000});break;
 case 'stitch':{
   const id=args[0],width=args[1];
   if(!/^[0-9]{8,16}$/.test(id||'')||args.length>2||
      (width!==undefined&&(!/^[0-9]{2,4}$/.test(width)||Number(width)<32||Number(width)>8192)))
    emit({status:'invalid_arguments',usage:'ecom stitch <productId> [width=source_mode]'},2);
   else simple('stitch-detail.mjs',['--product',id,...(width?['--width',width]:[])],{operation:'stitch',timeout:360000});
   break;
 }
 case 'html':if(args.length!==1)emit({status:'invalid_arguments',usage:'ecom html <productId>'},2);
  else simple('html-preview.mjs',['--product',args[0]],{operation:'html'});break;
 case 'ocr':if(args.length!==1)emit({status:'invalid_arguments',usage:'ecom ocr <productId>'},2);
  else simple('ocr.mjs',['--product',args[0]],{operation:'ocr',timeout:360000});break;
 case 'ocr-install':if(args.length)emit({status:'invalid_arguments',usage:'ecom ocr-install'},2);
  else simple('setup-ocr.mjs',['--install'],{operation:'ocr-install',timeout:360000});break;
 case 'browser':if(args.length!==1||!['start','status'].includes(args[0]))emit({status:'invalid_arguments',usage:'ecom browser start|status'},2);
  else simple('browser.mjs',args,{operation:'browser',timeout:45000});break;
 case 'industry-folders':if(!args.length||!['--check','--apply','--rollback'].includes(args[0])||args.length>3)
    emit({status:'invalid_arguments',usage:'ecom industry-folders --check [ID]|--apply <ID>|--all|--rollback <ID> [--apply]'},2);
    else simple('industry-folder-cli.mjs',args,{operation:'industry-folders',timeout:600000});break;
 case 'industry':if(!args.length||!['--check','--apply','--sync-eagle','--set','--list'].includes(args[0]))
    emit({status:'invalid_arguments',usage:'ecom industry --check|--apply|--sync-eagle [ID] | --set ID industry subcategory | --list [industry]'},2);
    else simple('industry-cli.mjs',args,{operation:'industry',timeout:480000});break;
  case 'list':if(args.length)emit({status:'invalid_arguments',usage:'ecom list'},2);
  else simple('captures.mjs',['list'],{operation:'list'});break;
 case 'help':
 default:emit({status:'help',usage:[
  'ecom setup [--check]  - install local dependencies, initialize, start Chrome, check Eagle',
  'ecom doctor           - read-only environment diagnosis',
  'ecom capture "<full Tmall URL>" [outputRoot]',
   'ecom v3-index --check [count]|--build - inspect/build local Eagle SHA-256 index',
   'ecom v3-prefetch --check|--cache <existingProductId> - test exact-byte CDN fetch without Eagle writes',
   'ecom v3-resume --check|--apply <productId> - only when event ledger proves zero Eagle writes',
   'ecom v3-resume-partial --check|--apply <productId> [originalTmallUrl] - protect submitted slots, import only proven unsubmitted originals',
   'ecom industry-folders --check [ID] | --apply <ID>|--all | --rollback <ID> [--apply] - move/restore full Eagle product folders',
   'ecom industry --check [productId] - preview category classification without writes',
   'ecom industry --apply [productId] - persist product-level industry metadata only',
   'ecom industry --sync-eagle [productId] - materialize tags and native smart-folder views',
   'ecom industry --set <productId> <industryCode> <subcategoryCode> - manual-locked correction',
   'ecom industry --list [industryCode] - list stored classifications',
   'ecom capture-v3 "<full Tmall URL>" [outputRoot] - EXPERIMENTAL; disabled unless local config enables v3Experimental',
  'ecom batch <urls.txt|urls.json> [--check|--apply] [--engine v2|v3] - serial verified queue; V3 requires local opt-in',
   'ecom source-closeout AA|BB --check|--prepare | --apply <snapshotId> - preserve original IDs, unlink only snapshot sources',
   'ecom map-eagle <productId> --check|--apply - verify and mirror product-level order map',
   'ecom reconcile-reused <productId> --check|--apply - map proven reused source without new imports',
   'ecom verify-live <productId> --check|--apply - reconcile current Eagle archive and long image into registry',
   'ecom recover-duplicates <productId> --check|--apply - optional exact duplicate recovery (max 10, verified local images)',
   'ecom scan "<full Tmall URL>" - read-only browser scan; no Eagle item_add',
  'ecom resume <productId> [outputRoot] - explicit safe resume only',
  'ecom migrate-eagle --check|--apply - move existing Eagle product folders under one root; retain item IDs',
  'ecom recover-eagle <productId> --check|--apply - recover verified local fallback files, no blind retry',
  'ecom finish <productId> - verify existing archive then stitch only the finished long image',
  'ecom archive <productId> [YYYY-MM-DD] [--check] - reconcile current Eagle files, preserves original receipt',
  'ecom stitch-eagle <productId> [width] [--date YYYY-MM-DD] [--check] - read Eagle originals, stitch, import JPEGs only',
  'ecom export <productId> - copy already verified Eagle images for OCR/stitch/export, without re-import',
  'ecom list | html <productId> | ocr <productId> | ocr-install | stitch <productId> [width]',
  'ecom browser start|status'
 ],exitCodes:{0:'completed or ready',2:'invalid/failed, no automatic re-import',10:'needs action (e.g. Eagle plugin/login)'}},command==='help'?0:2);
}
