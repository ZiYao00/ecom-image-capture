import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {loopbackPortOccupied} from '../scripts/browser-port.mjs';

test('Chrome launcher detects non-CDP TCP port occupancy before spawning',async()=>{
 const server=createServer(socket=>socket.destroy());
 await new Promise((resolve,reject)=>{
  server.once('error',reject);
  server.listen(0,'127.0.0.1',resolve);
 });
 try{
  const port=server.address().port;
  const result=await loopbackPortOccupied(port);
  assert.equal(result.occupied,true);
  assert.equal(result.ipv4,true);
 }finally{
  await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
 }
});
