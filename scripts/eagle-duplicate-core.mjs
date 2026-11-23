// Immutable, pixel-preserving byte variants for exact duplicate assets in Eagle.
// These utilities do not download images, mutate Eagle, or write to disk.
export function crc32Bytes(bytes){
 let crc=0xFFFFFFFF;
 for(const b of bytes){
  crc^=b;
  for(let bit=0;bit<8;bit++)crc=crc&1?(crc>>>1)^0xEDB88320:crc>>>1;
 }
 return (crc^0xFFFFFFFF)>>>0;
}
export function addDistinctMetadata(bytes,format,identity){
 const source=Buffer.from(bytes),label=String(identity||'');
 if(!label||label.length>180||/[^a-zA-Z0-9:_-]/.test(label))throw Error('Unsafe variant metadata label');
 const payload=Buffer.from('ECOM_CAPTURE:'+label,'ascii');
 const type=String(format||'').toLowerCase();
 if(type==='gif'){
  if(!['GIF87a','GIF89a'].includes(source.toString('ascii',0,6))||source.at(-1)!==0x3B||
     payload.length>255)throw Error('Invalid GIF for metadata injection');
  const extension=Buffer.concat([Buffer.from([0x21,0xFE,payload.length]),payload,Buffer.from([0])]);
  return Buffer.concat([source.subarray(0,-1),extension,Buffer.from([0x3B])]);
 }
 if(type==='png'){
  if(!source.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('Invalid PNG signature');
  let pos=8,iend=-1;
  while(pos+12<=source.length){
   const length=source.readUInt32BE(pos),name=source.toString('ascii',pos+4,pos+8);
   if(pos+12+length>source.length)throw Error('Invalid PNG chunk length');
   if(name==='IEND'){
    if(length!==0||pos+12!==source.length)throw Error('Invalid PNG trailer');
    iend=pos;break;
   }
   pos+=12+length;
  }
  if(iend<0)throw Error('IEND not found');
  const chunkData=Buffer.concat([Buffer.from('Comment\0','ascii'),payload]);
  const named=Buffer.from('tEXt','ascii');
  const chunk=Buffer.alloc(chunkData.length+12);
  chunk.writeUInt32BE(chunkData.length,0);named.copy(chunk,4);chunkData.copy(chunk,8);
  chunk.writeUInt32BE(crc32Bytes(Buffer.concat([named,chunkData])),8+chunkData.length);
  return Buffer.concat([source.subarray(0,iend),chunk,source.subarray(iend)]);
 }
 if(type==='jpg'||type==='jpeg'){
  if(source.length<4||source[0]!==0xFF||source[1]!==0xD8)throw Error('Invalid JPEG signature');
  const length=payload.length+2;
  if(length>65535)throw Error('JPEG comment too large');
  const marker=Buffer.alloc(4);marker[0]=0xFF;marker[1]=0xFE;marker.writeUInt16BE(length,2);
  return Buffer.concat([source.subarray(0,2),marker,payload,source.subarray(2)]);
 }
 throw Error('Byte-distinct metadata unsupported for format: '+type);
}
export function metadataFormatFromPath(file){
 const text=String(file||'').toLowerCase();
 if(text.endsWith('.gif'))return 'gif';
 if(text.endsWith('.png'))return 'png';
 if(text.endsWith('.jpg')||text.endsWith('.jpeg'))return 'jpg';
 return null;
}
