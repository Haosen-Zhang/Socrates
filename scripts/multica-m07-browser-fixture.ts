import { writeFileSync, unlinkSync } from 'node:fs';
import { setupCostFlowFixture, untilCostFlow } from '../apps/sidecar/src/services/cost-flow-fixture';

// Real production services with synthetic members, history and controlled model responses.
const nativeStream={chunks:0,delayMs:50};
const f = await setupCostFlowFixture({ routingFixture: true, nativeToolCalls: () => [], nativeStream });
f.sessions.rename(f.roomIds.work, 'M07 synthetic integration lab');
for (let i=3;i<36;i++) f.db.query(`INSERT INTO agents(id,display_name,nickname,avatar,provider_id,model_id,role,system_prompt,model_capabilities_json,created_at,updated_at) SELECT ?,?,?,avatar,provider_id,model_id,role,system_prompt,model_capabilities_json,created_at,updated_at FROM agents WHERE id='fixture-a'`).run(`scale-${i}`,`Synthetic role ${i}`,`Synthetic role ${i}`);
for (let i=0;i<12;i++) f.squads.create({workspaceId:f.workspace.id,name:`Synthetic squad ${i+1}`,avatar:'/avatars/owl-engineer.webp',leaderAgentId:'fixture-a',description:'Synthetic scale fixture',instructions:'Use approved work packages',members:[{agentId:'fixture-a',responsibility:'Lead'},{agentId:'fixture-b',responsibility:'Review'},{agentId:`scale-${i+3}`,responsibility:'Inspect'}]});
for(let i=0;i<120;i++) {
 const item=f.workItems.create({workspaceId:f.workspace.id,roomId:f.roomIds.work,title:`Synthetic task ${String(i+1).padStart(3,'0')}`,objective:'Controlled load measurement; not a real delivered task.',acceptanceCriteria:['Human review required'],ownerKind:'agent',ownerId:'fixture-a',priority:'normal'});
 const p=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'agent',ownerId:'fixture-a'});
 await f.workItemLaunch.start(item.id,{previewId:p.id,expectedRevision:item.revision,clientRequestId:`scale-${i}`});
 await untilCostFlow(()=>f.workItems.get(item.id)?.workflow==='in_review',`scale-${i}`);
 f.db.transaction(()=>{for(let j=0;j<40;j++)f.db.query("INSERT INTO session_messages(id,session_id,role,content,status,created_at) VALUES(?,?,'assistant',?,'completed',?)").run(crypto.randomUUID(),p.executionRoomId,`Synthetic historical message ${j}: `+'context '.repeat(256),new Date().toISOString());})();
}
for(const entry of f.inbox.list().items)f.inbox.read(entry.id,entry.revision);
const measure=()=>{const samples=[];let bytes=0;for(let n=0;n<5;n++){const start=performance.now();bytes=Buffer.byteLength(JSON.stringify(f.workItems.list(f.workspace.id)));samples.push(performance.now()-start);}return {samplesMs:samples,medianMs:[...samples].sort((a,b)=>a-b)[2],responseBytes:bytes,agents:36,squads:12,workItems:120,messagesPerRun:40};};
f.app.post('/__m07/long-stream',c=>{nativeStream.chunks=1200;const room=f.sessions.get(f.roomIds.work)!;f.sessions.updateCollaboration(room.id,{...room.collaboration,strategy:'single'});return c.json({chunks:1200,delayMs:50});});
f.app.get('/__m07/metrics',c=>c.json(measure()));
f.app.get('/__m07/counts',c=>c.json({native:f.nativeCalls.length,gateway:f.gatewayCalls.length}));
const metadataPath='/private/tmp/socrates-multica-m07.json';
const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,fetch:f.app.fetch});
writeFileSync(metadataPath,JSON.stringify({source:'synthetic-multica-m07',pid:process.pid,port:server.port,token:f.token,roomIds:f.roomIds,workspaceId:f.workspace.id,metrics:measure()}));
console.log('M07 synthetic fixture ready');
let closing=false;for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>{if(closing)return;closing=true;server.stop(true);void f.close().finally(()=>{try{unlinkSync(metadataPath);}catch{}process.exit(0);});});
