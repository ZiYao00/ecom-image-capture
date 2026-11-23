import test from 'node:test';
import assert from 'node:assert/strict';
import {archiveEagleProduct, archiveRootForDate} from '../scripts/eagle-archive.mjs';

const archive=(args)=>archiveEagleProduct({...args,fileExists:()=>true});
function mockEagle() {
  const state = {
    roots: [], items: new Map(), calls: [],
    nextId: 1
  };
  const add = (name, category, verified = true) => {
    const id = 'I' + state.nextId++;
    const image = {name, category, order: state.nextId, itemId: id, verified};
    if (verified) state.items.set(id, {
      id, name, filePath: 'X:/eagle/' + id + '.jpg', width: 750, height: 400, folders: []
    });
    return image;
  };
  const findFolder = (tree, id) => {
    for (const node of tree) {
      if (node.id === id) return node;
      const child = findFolder(node.children, id);
      if (child) return child;
    }
    return null;
  };
  const rpc = async (name, args = {}) => {
    state.calls.push({name, args});
    if (name === 'folder_get') return structuredClone(state.roots);
    if (name === 'folder_create') {
      for (const spec of args.folders) {
        const folder = {id: 'F' + state.nextId++, name: spec.name, children: []};
        const parent = spec.parentId ? findFolder(state.roots, spec.parentId) : null;
        if (spec.parentId && !parent) throw Error('missing parent');
        if (parent) parent.children.push(folder);
        else state.roots.push(folder);
      }
      return {success:true};
    }
    if (name === 'item_get') return args.ids.map(id => state.items.get(id)).filter(Boolean).map(x => structuredClone(x));
    if (name === 'item_add_to_folders') {
      for (const id of args.ids) {
        const item = state.items.get(id);
        if (!item) throw Error('missing item');
        for (const folder of args.folders) if (!item.folders.includes(folder)) item.folders.push(folder);
      }
      return {success:true};
    }
    throw Error('Unexpected API call ' + name);
  };
  return {state, add, rpc};
}

const id = '1100960492994';
const rootName = '天猫批量采集_2026-11-18';
test('date-based root is formatted with local calendar', () => {
  assert.equal(archiveRootForDate(new Date(2026, 10, 18)), rootName);
});
test('classifies only actual verified items, readback confirms all, and re-running is idempotent', async () => {
  const m = mockEagle(), images = [
    m.add('Tmall-'+id+'-main-001','main'),
    m.add('Tmall-'+id+'-detail-001','detail'),
    m.add('Tmall-'+id+'-detail-002','detail')
  ];
  const a = await archive({rpc:m.rpc,productId:id,images,rootName});
  assert.equal(a.status, 'complete');
  assert.deepEqual(a.classified,{main:1,detail:2});
  assert.equal(m.state.roots[0].children[0].name,'待分类');
   assert.equal(m.state.roots[0].children[0].children[0].children.length,2);
  const count = m.state.calls.filter(x=>x.name==='folder_create'||x.name==='item_add_to_folders').length;
  const again = await archive({rpc:m.rpc,productId:id,images,rootName});
  assert.equal(again.status,'complete');
  assert.equal(m.state.calls.filter(x=>x.name==='folder_create'||x.name==='item_add_to_folders').length,count);
  assert.equal(m.state.calls.filter(x=>x.name==='item_add').length,0);
});
test('partial Eagle batch is classified without representing missing images as success',async()=>{
  const m=mockEagle(), images=[m.add('Tmall-'+id+'-main-001','main'),
    m.add('Tmall-'+id+'-detail-001','detail'),
    m.add('Tmall-'+id+'-detail-002','detail',false)];
  const x=await archive({rpc:m.rpc,productId:id,images,rootName});
  assert.equal(x.status,'partial');
  assert.equal(x.classified.detail,1);
  assert.deepEqual(x.missing,['Tmall-'+id+'-detail-002']);
});
test('read-only check must not create folders or assign items',async()=>{
  const m=mockEagle(),images=[m.add('Tmall-'+id+'-detail-001','detail')];
  const r=await archive({rpc:m.rpc,productId:id,images,rootName,apply:false});
  assert.equal(r.status,'folders_missing');
  assert.equal(m.state.calls.filter(x=>x.name==='folder_create'||x.name==='item_add_to_folders').length,0);
});
test('blocks duplicate expected names, unsafe product ID and unexpected category',async()=>{
  const m=mockEagle(),im=m.add('Tmall-'+id+'-detail-001','detail');
  await assert.rejects(()=>archive({rpc:m.rpc,productId:id,images:[im,im],rootName}),/duplicated/);
  await assert.rejects(()=>archive({rpc:m.rpc,productId:'../foo',images:[im],rootName}),/Invalid product/);
  await assert.rejects(()=>archive({rpc:m.rpc,productId:id,images:[{...im,category:'other'}],rootName}),/category/);
});
test('shared Eagle original is classified under a new product without renaming or adding files',async()=>{
 const m=mockEagle();
 const foreign=m.add('Tmall-947780804552-detail-022','detail');
 const intended={...foreign,name:'Tmall-'+id+'-detail-001',order:1,
  eagleName:foreign.name,resolution:'reused',sha256:'a'.repeat(64)};
 const result=await archive({rpc:m.rpc,productId:id,images:[intended],rootName});
 assert.equal(result.status,'complete');
 assert.equal(result.classified.detail,1);
 assert.equal(m.state.items.get(foreign.itemId).name,foreign.name);
 assert.equal(m.state.calls.filter(x=>x.name==='item_add').length,0);
});

test('refuses ambiguous existing folder names before calling folder_create',async()=>{
  const m=mockEagle(),images=[m.add('Tmall-'+id+'-main-001','main')];
  m.state.roots.push({id:'F1',name:rootName,children:[]},{id:'F2',name:rootName,children:[]});
  await assert.rejects(()=>archive({rpc:m.rpc,productId:id,images,rootName}),/Duplicate Eagle folder/);
  assert.equal(m.state.calls.filter(x=>x.name==='folder_create').length,0);
});
