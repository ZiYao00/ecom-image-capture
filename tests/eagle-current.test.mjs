import test from 'node:test';
import assert from 'node:assert/strict';
import {expectedProductItems,findProductArchive,readCurrentEagleProduct} from '../scripts/eagle-current.mjs';
import {planEagleStitch,stitchPartName,stitchEagleProduct} from '../scripts/stitch-eagle-core.mjs';

const pid='999999999999',rootName='天猫批量采集_2026-11-19';
function mock(){
  const images=[
    {name:'Tmall-'+pid+'-main-001',category:'main',order:1,ext:'jpg',verified:true,itemId:'OLD1'},
    {name:'Tmall-'+pid+'-detail-001',category:'detail',order:1,ext:'gif',verified:false,itemId:'OLD2'},
    {name:'Tmall-'+pid+'-detail-002',category:'detail',order:2,ext:'jpg',verified:true,itemId:'OLD3'}
  ];
  const roots=[{id:'ROOT',name:rootName,children:[{id:'PROD',name:pid,children:[
    {id:'MAIN',name:'主图',children:[]},{id:'DETAIL',name:'详情页',children:[]}
  ]}]}];
  const entries={
    MAIN:[{id:'N1',name:images[0].name,ext:'jpg',width:750,height:500,folders:['MAIN'],filePath:'X:/eagle/images/N1.info/a.jpg'}],
    DETAIL:[
      {id:'NEW2',name:images[1].name,ext:'webp',width:750,height:400,folders:['DETAIL'],filePath:'X:/eagle/images/NEW2.info/b.webp'},
      {id:'N3',name:images[2].name,ext:'jpg',width:750,height:800,folders:['DETAIL'],filePath:'X:/eagle/images/N3.info/c.jpg'},
      {id:'SOURCE',name:'source URL thumbnail',ext:'jpg',width:200,height:100,folders:['DETAIL'],filePath:'X:/eagle/images/SOURCE.info/source.jpg'}
    ],
    PROD:[]
  };
  const calls=[];
  const rpc=async(name,args={})=>{
    calls.push({name,args});
    if(name==='folder_get')return structuredClone(roots);
    if(name==='item_get'){
      if(args.folders)return structuredClone(entries[args.folders[0]]||[]);
      if(args.ids)return Object.values(entries).flat().filter(x=>args.ids.includes(x.id));
    }
    throw Error('Unexpected Eagle write '+name);
  };
  const inspectFile=async item=>({filePath:item.filePath,bytes:12345,sha256:'sha-'+item.id});
  return {images,roots,entries,rpc,inspectFile,calls};
}
test('historical date is found from Eagle tree without using today',()=>{
  const m=mock();
  const x=findProductArchive(m.roots,pid);
  assert.equal(x.rootName,rootName);
  assert.equal(x.detailFolderId,'DETAIL');
  m.roots.push(structuredClone({...m.roots[0],id:'ROOT2',name:'天猫批量采集_2026-11-18'}));
  assert.throws(()=>findProductArchive(m.roots,pid),/Ambiguous/);
  assert.equal(findProductArchive(m.roots,pid,{rootName}).rootId,'ROOT');
});
test('current Eagle repaired new item ID overrides stale receipt flags without modifying receipt',async()=>{
  const m=mock(),before=JSON.stringify(m.images);
  const x=await readCurrentEagleProduct({rpc:m.rpc,productId:pid,images:m.images,inspectFile:m.inspectFile});
  assert.equal(x.status,'complete');
  assert.deepEqual(x.counts,{main:1,detail:2});
  assert.equal(x.items.find(y=>y.order===1&&y.category==='detail').id,'NEW2');
  assert.deepEqual(x.formatChanges,[{name:m.images[1].name,originalExt:'gif',actualExt:'webp'}]);
  assert.equal(x.unrelated.length,1);
  assert.equal(JSON.stringify(m.images),before);
  assert.ok(m.calls.every(z=>['folder_get','item_get'].includes(z.name)));
});
test('missing physical image or item is explicitly partial, no success',async()=>{
  const m=mock(),out=await readCurrentEagleProduct({
    rpc:m.rpc,productId:pid,images:m.images,
    inspectFile:async item=>{if(item.id==='NEW2')throw Error('file missing');return m.inspectFile(item)}
  });
  assert.equal(out.status,'partial');
  assert.ok(out.invalid.some(x=>x.reason==='file missing'));
  m.entries.DETAIL=m.entries.DETAIL.filter(x=>x.id!=='N3');
  const out2=await readCurrentEagleProduct({rpc:m.rpc,productId:pid,images:m.images,inspectFile:m.inspectFile});
  assert.equal(out2.status,'partial');
  assert.deepEqual(out2.missing,[m.images[2].name]);
});
test('duplicate exact image name and malformed order cannot pass',async()=>{
  const m=mock();
  m.entries.DETAIL.push(structuredClone({...m.entries.DETAIL[0],id:'N4'}));
  const out=await readCurrentEagleProduct({rpc:m.rpc,productId:pid,images:m.images,inspectFile:m.inspectFile});
  assert.equal(out.status,'partial');
  assert.ok(out.invalid.some(x=>x.reason==='duplicate_exact_name'));
  assert.throws(()=>expectedProductItems([m.images[2]],pid),/Missing\/duplicate detail image order/);
});
test('stitch preflight uses current Eagle source, not stale receipt verified flags',async()=>{
  const m=mock();
  const ready=await stitchEagleProduct({rpc:m.rpc,productId:pid,images:m.images,
    inspectFile:m.inspectFile,outputRoot:'data/stitch-tests/no-write',apply:false});
  assert.equal(ready.status,'ready');
  assert.equal(ready.sourceCount,2);
  assert.equal(ready.exportedSourceFiles,0);
  assert.equal(ready.width,750);
  assert.deepEqual(ready.partNames,[stitchPartName(pid,750,1,1)]);
  assert.equal(m.calls.filter(x=>x.name==='item_add').length,0);
});
test('existing long image is not imported again',async()=>{
  const m=mock(),name=stitchPartName(pid,750,1,1);
  m.entries.PROD.push({id:'EXISTING',name,ext:'jpg',width:750,height:1200,folders:['PROD'],
    filePath:'X:/eagle/images/EXISTING.info/long.jpg'});
  const s=await stitchEagleProduct({rpc:m.rpc,productId:pid,images:m.images,
    inspectFile:m.inspectFile,outputRoot:'data/stitch-tests/no-write',apply:false});
  assert.equal(s.status,'existing_eagle_targets_no_retry');
});
test('missing detail prevents stitching even with successful old receipt',async()=>{
  const m=mock();
  m.entries.DETAIL=m.entries.DETAIL.filter(x=>x.id!=='NEW2');
  const s=await stitchEagleProduct({rpc:m.rpc,productId:pid,images:m.images,
    inspectFile:m.inspectFile,outputRoot:'data/stitch-tests/no-write',apply:false});
  assert.equal(s.status,'incomplete_eagle_sources');
});
test('split naming has deterministic part numbers',()=>{
 assert.equal(stitchPartName(pid,750,1,2),'Tmall-'+pid+'-detail-long-750w-part1');
 assert.equal(stitchPartName(pid,750,2,2),'Tmall-'+pid+'-detail-long-750w-part2');
 const snapshot={status:'complete',productId:pid,expected:{detail:2},items:[
  {name:'Tmall-'+pid+'-detail-001',category:'detail',order:1,width:750,height:16000,id:'A',sha256:'A'},
  {name:'Tmall-'+pid+'-detail-002',category:'detail',order:2,width:750,height:16000,id:'B',sha256:'B'}
 ]};
 const p=planEagleStitch(snapshot,{width:750,maxHeight:20000});
 assert.equal(p.partCount,2);
 assert.equal(p.partHeights.reduce((a,b)=>a+b,0),32000);
});
