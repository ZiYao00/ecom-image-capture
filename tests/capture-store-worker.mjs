import {updateProduct,canonicalProductUrl} from '../scripts/capture-store.mjs';
const [root,id]=process.argv.slice(2);
if(!root||!/^\d{8,16}$/.test(id))throw Error('Missing worker root/ID');
const link=canonicalProductUrl('https://detail.tmall.com/item.htm?id='+id);
await updateProduct(root,{...link,status:'pending',mainCount:0,detailCount:0,
 verifiedCount:0,copiedCount:0,durationMs:null,outputDir:null});
