// Conservative local TCP port occupancy check for Chrome's IPv4/IPv6 loopback listeners.
import {connect} from 'node:net';

export function canConnect(host,port,timeoutMs=900){
 return new Promise(resolve=>{
   const socket=connect({host,port});
   let done=false;
   const finish=ok=>{
     if(done)return;
     done=true;
     socket.destroy();
     resolve(ok);
   };
   socket.once('connect',()=>finish(true));
   socket.once('error',()=>finish(false));
   socket.setTimeout(timeoutMs,()=>finish(false));
 });
}
export async function loopbackPortOccupied(port){
 const [ipv4,ipv6]=await Promise.all([
  canConnect('127.0.0.1',port),
  canConnect('::1',port)
 ]);
 return {ipv4,ipv6,occupied:ipv4||ipv6};
}
