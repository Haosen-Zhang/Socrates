import { writeFileSync, unlinkSync } from "node:fs";
import { setupCostFlowFixture, untilCostFlow } from "../apps/sidecar/src/services/cost-flow-fixture";

// Uses production services with only external model responses controlled. No live data/key.
const f=await setupCostFlowFixture();
const room=f.sessions.get(f.roomIds.work)!;
f.sessions.rename(room.id,"Foundation Work");
f.sessions.rename(f.roomIds.chat,"Foundation Chat");
const second=f.sessions.create({title:"Foundation Second Room",mode:"single_agent",workspaceId:f.workspace.id,primaryAgentId:"fixture-a",agents:[room.agents[0]!]});
f.db.query(`INSERT INTO agents(id,display_name,nickname,avatar,provider_id,model_id,role,system_prompt,reasoning_effort,model_capabilities_json,created_at,updated_at)
 SELECT 'fixture-c','雪松编辑','雪松编辑',avatar,provider_id,model_id,'Editor / 编辑',system_prompt,reasoning_effort,model_capabilities_json,created_at,updated_at FROM agents WHERE id='fixture-a'`).run();
const insert=f.db.query("INSERT INTO session_messages(id,session_id,role,author_id,content,status,created_at) VALUES (?,?,?,?,?,'completed',?)");
for(let i=0;i<140;i++)insert.run(`history-${i}`,f.roomIds.chat,i%2 ? "assistant":"user",i%2 ? "fixture-a":null,`Synthetic history ${i}. `+"Reading position remains within this room. ".repeat(5),new Date(Date.UTC(2026,10,1,0,i)).toISOString());
f.sessions.updateCollaboration(room.id,{...room.collaboration,strategy:"single"});
const direct=await f.commands.submit({roomId:room.id,clientRequestId:"foundation-direct",content:"Deliver a controlled result",intent:"execute",mentions:[]});
await untilCostFlow(()=>f.commands.get(direct.commandId)?.status === "completed","foundation_native");
f.sessions.updateCollaboration(room.id,room.collaboration);
const team=await f.commands.submit({roomId:room.id,clientRequestId:"foundation-team",content:"Plan a controlled team task",intent:"execute",mentions:[]});
await untilCostFlow(()=>f.tasks.get(team.taskId!)?.state === "awaiting_plan_approval","foundation_plan");
// Keep the room idle for roster operations; cancel through the real coordinator.
await f.coordinator.cancel(team.taskId!);
f.app.get("/__foundation/counts",c=>c.json({gateway:f.gatewayCalls.length,native:f.nativeCalls.length}));
const server=Bun.serve({hostname:"127.0.0.1",port:0,idleTimeout:0,fetch:f.app.fetch});
const metadataPath="/private/tmp/socrates-work-foundation-fixture.json";
writeFileSync(metadataPath,JSON.stringify({source:"synthetic-work-foundation",port:server.port,token:f.token,processId:process.pid,roomIds:{...f.roomIds,second:second.id},workspaceId:f.workspace.id,commandIds:{direct:direct.commandId,team:team.commandId}},null,2));
console.log(JSON.stringify({metadataPath,port:server.port,source:"synthetic-work-foundation"}));
let stopping=false;
for(const signal of ["SIGTERM","SIGINT"] as const)process.on(signal,()=>{
  if(stopping)return;stopping=true;server.stop(true);
  void f.close().finally(()=>{try{unlinkSync(metadataPath);}catch{/* already removed */}process.exit(0);});
});
