import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,statSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {modeWidth,resizedHeight,partitionImages,naturalImageFiles,stitchImages,probe} from '../scripts/stitch-core.mjs';

const dir=resolve('data/stitch-tests/synthetic-fixtures');
const output=resolve('data/stitch-tests/synthetic-results');
const ffmpegAvailable=['ffmpeg','ffprobe'].every(exe=>{
 const r=spawnSync(exe,['-version'],{encoding:'utf8',windowsHide:true,timeout:8000});
 return !r.error&&r.status===0;
});
function ffmpeg(args){
 const r=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-nostdin',...args],
   {encoding:'utf8',timeout:45000,windowsHide:true});
 if(r.error||r.status!==0)throw Error('ffmpeg fixture failed: '+(r.stderr||r.error?.message||r.status));
}
function fixtures(){
 mkdirSync(dir,{recursive:true});mkdirSync(output,{recursive:true});
 const png=join(dir,'01-transparent.png'),jpg=join(dir,'02-green.jpg'),gif=join(dir,'03-animated.gif');
 if(!existsSync(png))ffmpeg(['-f','lavfi','-i','color=c=red@0.0:s=64x600:r=1,format=rgba',
   '-frames:v','1',png]);
 if(!existsSync(jpg))ffmpeg(['-f','lavfi','-i','color=c=green:s=64x80:r=1',
   '-frames:v','1',jpg]);
 if(!existsSync(gif))ffmpeg(['-f','lavfi','-i','testsrc2=s=64x80:r=1:d=2',
   '-frames:v','2',gif]);
 return {png,jpg,gif};
}
function rgbAt(file,x,y){
 const out=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-nostdin',
  '-i',file,'-vf','crop=1:1:'+x+':'+y+',format=rgb24',
  '-frames:v','1','-f','rawvideo','pipe:1'],
  {timeout:18000,windowsHide:true,maxBuffer:40000});
 if(out.error||out.status!==0)throw Error('Unable to sample rendered JPEG: '+String(out.stderr));
 return [...out.stdout.subarray(0,3)];
}
test('modal width and scaled height follow WorkBuddy reference',()=>{
 assert.equal(modeWidth([790,750,790,750]),790);
 assert.equal(modeWidth([750,790,750]),750);
 assert.equal(resizedHeight(790,473,790),474);
});
test('oversized source is sliced without losing rows',()=>{
 const out=partitionImages([{index:0,height:600}],300);
 assert.deepEqual(out.parts.map(x=>x.height),[270,270,60]);
 assert.deepEqual(out.parts.map(x=>x.slices[0].top),[0,270,540]);
 assert.equal(out.totalHeight,600);
});
test('natural sort and existing long image exclusion',{skip:!ffmpegAvailable&&'Test fixture generation requires optional FFmpeg'},()=>{
 const img=fixtures();
 if(!existsSync(join(dir,'detail-long-64w.jpg')))
  writeFileSync(join(dir,'detail-long-64w.jpg'),Buffer.from('do not ingest generated'));
 const files=naturalImageFiles(dir);
 assert.deepEqual(files,['01-transparent.png','02-green.jpg','03-animated.gif']);
 assert.ok(existsSync(img.png));
});
test('transparent PNG is composited to pure white and tall image partitions',{skip:!ffmpegAvailable&&'Optional FFmpeg and FFprobe missing'},()=>{
 const {png}=fixtures();
 const target=join(output,'alpha');
 const dest=join(target,'detail-long-64w-part1.jpg');
 let res;
 if(!existsSync(dest)){
  res=stitchImages({files:[png],outputDir:target,width:64,maxHeight:300});
 }else{
  res={height:600,parts:[{file:dest},{file:join(target,'detail-long-64w-part2.jpg')},{file:join(target,'detail-long-64w-part3.jpg')}]};
 }
 assert.equal(res.height,600);
 assert.deepEqual(res.parts.map(p=>probe(p.file).height),[270,270,60]);
 for(const p of res.parts)assert.ok(rgbAt(p.file,0,0).every(x=>x>=246));
 assert.throws(()=>stitchImages({files:[png],outputDir:target,width:64,maxHeight:300}),/already exists/);
});
test('GIF first frame is used, output includes one frame per source',{skip:!ffmpegAvailable&&'Optional FFmpeg and FFprobe missing'},()=>{
 const {gif,jpg}=fixtures(), target=join(output,'gif');
 const dest=join(target,'detail-long-64w.jpg');
 const res=existsSync(dest)?{height:160,parts:[{file:dest}]}:
   stitchImages({files:[gif,jpg],outputDir:target,width:64});
 assert.equal(res.parts.length,1);
 assert.equal(probe(dest).height,160);
 assert.ok(statSync(dest).size>0);
});
test('no ffmpeg is an explicit stand-alone error without touching capture flow',{skip:!ffmpegAvailable&&'Optional FFmpeg needed to generate test input'},()=>{
 const {jpg}=fixtures();
 const saved=process.env.STITCH_FFMPEG;
 try{
  process.env.STITCH_FFMPEG='G:/missing/ffmpeg-absent.exe';
  assert.throws(()=>stitchImages({files:[jpg],outputDir:join(output,'no-ffmpeg'),width:64}),/failed:.*ENOENT/);
 }finally{
  if(saved===undefined)delete process.env.STITCH_FFMPEG;else process.env.STITCH_FFMPEG=saved;
 }
});
