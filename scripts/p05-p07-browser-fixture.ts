import {writeFileSync,unlinkSync} from 'node:fs';
import {setupCostFlowFixture,untilCostFlow} from '../apps/sidecar/src/services/cost-flow-fixture';
const f=await setupCostFlowFixture({routingFixture:true,nativeToolCalls:(body)=>{
 const request=body as {messages:Array<{role:string}>,tools?:unknown[]};
 return request.tools?.length&&!request.messages.some(m=>m.role==='tool')?[{id:'browser-write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'result.txt',content:'Written once by controlled Native tool.\n',expectedSha256:null})}},{id:'browser-read',type:'function',function:{name:'read_file',arguments:JSON.stringify({path:'context.txt'})}}]:[];
}});
const room=f.sessions.get(f.roomIds.work)!;
f.sessions.rename(room.id,'Delivery Lab');
f.sessions.updateCollaboration(room.id,{...room.collaboration,strategy:'single'});
const command=await f.commands.submit({roomId:room.id,clientRequestId:'initial-audit',content:'Create a local fixture artifact for audit',intent:'execute',mentions:[]});
await untilCostFlow(()=>f.commands.get(command.commandId)?.status==='completed','fixture_completed');
const metadataPath='/private/tmp/socrates-p05-p07-browser.json';
const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,fetch:f.app.fetch});
writeFileSync(metadataPath,JSON.stringify({source:'synthetic-p05-p07',processId:process.pid,port:server.port,token:f.token,roomIds:f.roomIds,commandId:command.commandId,workspaceId:f.workspace.id}));
console.log(JSON.stringify({metadataPath,port:server.port}));
let closing=false;
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{if(closing)return;closing=true;server.stop(true);void f.close().finally(()=>{try{unlinkSync(metadataPath);}catch{}process.exit(0);});});
