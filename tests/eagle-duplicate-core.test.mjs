import test from 'node:test';
import assert from 'node:assert/strict';
import {addDistinctMetadata,crc32Bytes,metadataFormatFromPath} from '../scripts/eagle-duplicate-core.mjs';
test('PNG metadata is byte-distinct while IDAT data and original bytes remain untouched',()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+XH2GaQAAAABJRU5ErkJggg==','base64');
 const copied=Buffer.from(png);
 const mod=addDistinctMetadata(png,'png','123456789012:detail-002:abcdef');
 assert.ok(!mod.equals(png));
 assert.ok(png.equals(copied));
 assert.ok(mod.includes(Buffer.from('tEXtComment\0ECOM_CAPTURE:','ascii')));
 assert.ok(mod.subarray(-12).equals(png.subarray(-12)));
 assert.equal(crc32Bytes(Buffer.from('123456789','ascii')),0xCBF43926);
});
test('GIF comment metadata leaves all existing frame bytes and trailer unchanged',()=>{
 const gif=Buffer.from('GIF89a'+String.fromCharCode(1,2,3,4,5)+';','binary');
 const changed=addDistinctMetadata(gif,'gif','123456789012:detail-001:aabbcc');
 assert.ok(changed.subarray(0,-changed.length+gif.length-1).length>=0);
 assert.ok(changed.subarray(0,gif.length-1).equals(gif.subarray(0,-1)));
 assert.equal(changed.at(-1),0x3B);
 assert.equal(changed[gif.length-1],0x21);
 assert.equal(changed[gif.length],0xFE);
});
test('JPEG comment metadata is inserted after SOI, and invalid formats rejected',()=>{
 const jpeg=Buffer.from([0xff,0xd8,0xff,0xd9]);
 const result=addDistinctMetadata(jpeg,'jpg','123456789012:detail-004:ffee');
 assert.deepEqual([...result.subarray(0,4)],[0xff,0xd8,0xff,0xfe]);
 assert.deepEqual([...result.subarray(-2)],[0xff,0xd9]);
 assert.throws(()=>addDistinctMetadata(Buffer.from('abc'),'webp','safe'),/unsupported/);
 assert.throws(()=>addDistinctMetadata(Buffer.from('abc'),'gif','safe'),/Invalid GIF/);
 assert.equal(metadataFormatFromPath('foo.webp'),null);
 assert.equal(metadataFormatFromPath('foo.PNG'),'png');
});
