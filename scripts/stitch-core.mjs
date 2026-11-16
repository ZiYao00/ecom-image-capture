// Detached, opt-in image stitching core (Node.js + existing ffmpeg/ffprobe).
// This module never contacts Chrome/Eagle or mutates capture receipts.
import {spawnSync} from 'node:child_process';
import {existsSync,readdirSync,statSync,mkdirSync,renameSync} from 'node:fs';
import {basename,dirname,extname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

export const IMAGE_EXTENSIONS=new Set(['.jpg','.jpeg','.png','.gif','.webp']);
export const GENERATED_IMAGE=/^(?:stitched|detail-long)-\d+w(?:-part\d+)?\.(?:jpg|jpeg|png|webp)$/i;

export function naturalImageFiles(folder){
  return readdirSync(folder,{withFileTypes:true})
    .filter(x=>x.isFile()&&IMAGE_EXTENSIONS.has(extname(x.name).toLowerCase())&&!GENERATED_IMAGE.test(x.name))
    .map(x=>x.name).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'}));
}
export function modeWidth(widths){
  if(!widths.length)throw Error('No images to inspect');
  const counts=new Map();
  for(const w of widths){
    if(!Number.isInteger(w)||w<1)throw Error('Invalid source width');
    counts.set(w,(counts.get(w)||0)+1);
  }
  return [...counts].sort((a,b)=>b[1]-a[1]||b[0]-a[0])[0][0];
}
export function resizedHeight(w,h,target){
  if(![w,h,target].every(x=>Number.isInteger(x)&&x>0))throw Error('Invalid dimensions');
  return Math.max(2,Math.round((h*target/w)/2)*2);
}
export function partitionImages(images,maxHeight=65500){
  if(!Number.isInteger(maxHeight)||maxHeight<200||maxHeight>65500)
    throw Error('maxHeight must be an integer between 200 and 65500');
  if(!images.length)throw Error('No images');
  const total=images.reduce((n,x)=>n+x.height,0);
  const cap=total>maxHeight ? 2*Math.floor(maxHeight*0.9/2) : maxHeight;
  const parts=[]; let current=[],height=0;
  const flush=()=>{if(current.length){parts.push({slices:current,height});current=[];height=0}};
  for(const img of images){
    if(!Number.isInteger(img.height)||img.height<=0||img.height%2)
      throw Error('Resized image heights must be positive and even');
    if(img.height<=cap){
      if(height+img.height>cap)flush();
      current.push({...img,top:0,take:img.height});
      height+=img.height;
      continue;
    }
    // A single oversized image is split without dropping a scanline.
    flush();
    let top=0;
    while(top<img.height){
      const take=Math.min(cap,img.height-top);
      current.push({...img,top,take});height+=take;top+=take;
      if(height>=cap)flush();
    }
  }
  flush();
  if(parts.some(p=>p.height>maxHeight))throw Error('Segment planning exceeded JPEG height limit');
  const sum=parts.reduce((n,p)=>n+p.height,0);
  if(sum!==total)throw Error('Segmentation lost source pixels');
  return {parts,totalHeight:total,cap};
}
function run(exe,args,{timeout=180000}={}){
  const result=spawnSync(exe,args,{encoding:'utf8',timeout,windowsHide:true,
    stdio:['ignore','pipe','pipe'],maxBuffer:4*1024*1024});
  if(result.error||result.status!==0){
    const reason=result.error?.message||(result.stderr||result.stdout||'Unknown error').slice(-1300);
    throw Error(exe+' failed: '+reason);
  }
  return result.stdout||'';
}
export function probe(file){
  const text=run(process.env.STITCH_FFPROBE||'ffprobe',
    ['-v','error','-select_streams','v:0','-show_entries','stream=width,height',
      '-of','json',file],{timeout:15000});
  const {width,height}=JSON.parse(text).streams?.[0]||{};
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<=0||height<=0)
    throw Error('ffprobe did not return image dimensions: '+file);
  return {width,height};
}
export function ensureDependencies(){
  run(process.env.STITCH_FFMPEG||'ffmpeg',['-version'],{timeout:9000});
  run(process.env.STITCH_FFPROBE||'ffprobe',['-version'],{timeout:9000});
}
function stageOne(part,paths,target,outFile){
  const args=['-hide_banner','-loglevel','error','-nostdin','-filter_complex_threads','2'];
  part.slices.forEach(slice=>args.push('-i',paths[slice.index]));
  const steps=[],last=[];
  part.slices.forEach((slice,i)=>{
    const base='[flat'+i+']',end='[out'+i+']';
    // RGB overlay avoids intermediate 4:2:0 color subsampling, white flattens transparency.
    steps.push('['+i+":v]select='eq(n\\,0)',scale="+target+':-2:flags=lanczos,setsar=1,format=rgba[fg'+i+']');
    steps.push('color=c=white:s='+target+'x'+slice.height+':r=1[bg'+i+']');
    steps.push('[bg'+i+'][fg'+i+']overlay=shortest=1:repeatlast=0:format=rgb,format=rgb24'+base);
    if(slice.top!==0||slice.take!==slice.height){
      steps.push(base+'crop='+target+':'+slice.take+':0:'+slice.top+end);
    }else{
      steps.push(base+'null'+end);
    }
    last.push(end);
  });
  if(last.length===1)steps.push(last[0]+'format=rgb24[stack]');
  else steps.push(last.join('')+'vstack=inputs='+last.length+':shortest=1,format=rgb24[stack]');
  args.push('-filter_complex',steps.join(';'),'-map','[stack]',
    '-frames:v','1','-q:v','2','-pix_fmt','yuvj444p',outFile);
  run(process.env.STITCH_FFMPEG||'ffmpeg',args,{timeout:240000});
}
export function stitchImages({files,outputDir,width=null,maxHeight=65500}){
  if(!Array.isArray(files)||!files.length)throw Error('No input image files');
  ensureDependencies();
  const input=files.map(p=>resolve(p));
  for(const p of input){
    if(!existsSync(p)||!IMAGE_EXTENSIONS.has(extname(p).toLowerCase())||!statSync(p).isFile())
      throw Error('Invalid input image: '+p);
  }
  const dims=input.map(probe);
  const target=width===null?modeWidth(dims.map(x=>x.width)):Number(width);
  if(!Number.isInteger(target)||target<32||target>8192)
    throw Error('Output width must be an integer between 32 and 8192');
  const entries=dims.map((d,index)=>({index,height:resizedHeight(d.width,d.height,target)}));
  const plan=partitionImages(entries,Number(maxHeight));
  const nameBase='detail-long-'+target+'w';
  const targets=plan.parts.map((p,i)=>join(outputDir,
    nameBase+(plan.parts.length>1?'-part'+(i+1):'')+'.jpg'));
  // Never overwrite manual, earlier, or concurrently published work.
  for(const dest of targets)if(existsSync(dest))
    throw Error('Target long image already exists; no overwrite attempted: '+dest);
  mkdirSync(outputDir,{recursive:true});
  const tempPaths=targets.map(x=>join(dirname(x),'.stitch-stage-'+randomUUID()+'-'+basename(x)));
  const written=[];
  for(let i=0;i<plan.parts.length;i++){
    stageOne(plan.parts[i],input,target,tempPaths[i]);
    if(!existsSync(tempPaths[i])||!statSync(tempPaths[i]).size)
      throw Error('FFmpeg output missing/empty: '+tempPaths[i]);
    const result=probe(tempPaths[i]);
    if(result.width!==target||result.height!==plan.parts[i].height)
      throw Error('Encoded output dimensions mismatch: '+JSON.stringify(result)+
        ' expected '+target+'x'+plan.parts[i].height+'. Staged file kept for inspection.');
    written.push({path:tempPaths[i],height:result.height});
  }
  // All segments are validated before publishing any part.
  const parts=[];
  for(let i=0;i<targets.length;i++){
    if(existsSync(targets[i]))throw Error('Target appeared during build; refuse overwrite: '+targets[i]);
    renameSync(written[i].path,targets[i]);
    parts.push({file:targets[i],width:target,height:written[i].height,bytes:statSync(targets[i]).size});
  }
  return {status:'ok',images:files.length,width:target,height:plan.totalHeight,
    parts,alphaBackground:'#FFFFFF',colorFormat:'yuvj444p',inputModified:false};
}
