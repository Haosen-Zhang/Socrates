// Isolated UI fixture: in-memory SQLite, fake model and scratch workspace only.
// Run from the repo root: bun apps/sidecar/scripts/chat-work-preview.ts
import { NativeAgentRuntime } from "../src/runtime/native-agent-runtime";
import { ToolRegistry } from "../src/tools/registry";
import { ToolExecutor } from "../src/tools/executor";
import { createWorkspaceWriteBuiltins } from "../src/tools/workspace-write-builtins";
import { WorkspacePathPolicy } from "../src/workspace/path-policy";
import { HistoryStore } from "../src/store/history-store";
import { legacyRoomSessionsMigration } from "../src/store/migrations/022_legacy_room_sessions";
import { roomRoutes } from "../src/rooms";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { mkdirSync, writeFileSync } from "node:fs";
import { openDb } from "../src/db";
import { SessionStore } from "../src/store/session-store";
import { EventStore } from "../src/store/event-store";
import { ExecutionEventStore } from "../src/store/execution-event-store";
import { WorkspaceManager } from "../src/workspace/manager";
import { WorkspaceLeaseManager } from "../src/workspace/leases";
import { ApprovalManager } from "../src/approvals/manager";
import { AttachmentResolver } from "../src/attachments/resolver";
import { RuntimeManager } from "../src/runtime/runtime-manager";
import { SingleAgentRunner } from "../src/runtime/single-agent-runner";
import { RunSupervisor } from "../src/runtime/run-supervisor";
import { agentRunRoutes } from "../src/routes/agent-runs";
import { sessionRoutes } from "../src/routes/sessions";
import { workspaceRoutes } from "../src/routes/workspaces";
import { contentRoutes } from "../src/routes/content";
import { resolveRoomFileContext } from "../src/services/room-file-context";
import { RoomCommandService } from "../src/services/room-command-service";
import { roomCommandRoutes } from "../src/routes/room-commands";
import { MultiTaskStore } from "../src/multi-agent/task-store";
import { MultiAgentCoordinator } from "../src/multi-agent/coordinator";
import { WorkPackageStore } from "../src/multi-agent/work-package-store";
import { TeamRunner } from "../src/multi-agent/team-runner";
import { ExecutionRunner } from "../src/runtime/execution-runner";
import { multiAgentRoutes } from "../src/routes/multi-agent";
import { agentRoutes, toAgent, type AgentRow } from "../src/agents";
import { providerRoutes } from "../src/providers";
import { MemorySecrets } from "../src/secrets";
import { ConfigStore, configRoutes } from "../src/config-store";
import { UNKNOWN_MODEL_CAPABILITIES, type ModelGateway } from "@socrates/core";

const root = `/tmp/socrates-ui-${process.pid}`;
mkdirSync(root, { recursive: true });
writeFileSync(`${root}/README.md`, "UI validation scratch file\n");
const db = openDb(":memory:"), history = new HistoryStore(db, `${root}/history`), sessions = new SessionStore(db, history), events = new EventStore(db), executionEvents = new ExecutionEventStore(db);
const workspaces = new WorkspaceManager(db, `${root}/managed`), workspace = workspaces.select(root);
const secrets = new MemorySecrets(); secrets.set("fixture-key", "fixture-only");
const now = new Date().toISOString();
db.run("INSERT INTO providers(id,name,type,base_url,api_key_ref,enabled,created_at,updated_at) VALUES ('mock','Mock Provider','openai_compatible','http://mock.invalid/v1','fixture-key',1,?,?)", [now,now]);
for (const [id,name] of [["a","Ada"],["b","Babbage"]]) db.run("INSERT INTO agents(id,display_name,nickname,provider_id,model_id,role,system_prompt,model_capabilities_json,created_at,updated_at) VALUES (?,?,?,'mock','mock-model',?,'',?,?,?)", [id!,name!,name!,id === "a" ? "Manager / developer" : "Reviewer / developer",JSON.stringify(UNKNOWN_MODEL_CAPABILITIES),now,now]);
const template = (id: string) => ({ ...toAgent(db.query<AgentRow,[string]>("SELECT * FROM agents WHERE id=?").get(id)!) });
const members = ["a","b"].map((id) => ({ agentId:id,snapshot:template(id),executionEligible:true }));
sessions.create({id:"chat-one",kind:"chat",mode:"chat",title:"Chat one",primaryAgentId:"a",agents:members});
sessions.create({id:"chat-two",kind:"chat",mode:"chat",title:"Chat two",primaryAgentId:"b",agents:members});
sessions.create({id:"work-one",kind:"cowork",mode:"multi_agent",title:"Work one",workspaceId:workspace.id,primaryAgentId:"a",agents:members});
const approvals=new ApprovalManager(db), attachments=new AttachmentResolver(db,root), runtimes=new RuntimeManager(db,executionEvents);
runtimes.register("native_ai_sdk", opening => {
  const room = sessions.get(opening.sessionId)!;
  const registry = new ToolRegistry(room.kind === "cowork" ? createWorkspaceWriteBuiltins(new WorkspacePathPolicy(root)) : []);
  return new NativeAgentRuntime({ sessionId: room.id, taskId: opening.agentSessionId, agentId: opening.agentId,
    workspaceId: room.workspaceId ?? "", workspaceIdentity: room.workspaceId ?? "chat", registry,
    executor: new ToolExecutor(db, registry, approvals, undefined, executionEvents),
    allowedCapabilities: room.kind === "cowork" ? ["workspace_write"] : [],
    stream: async function* (input) {
      for (const text of [`${String(template(opening.agentId).nickname)}: `, "模拟流式输出。", "完成。"]) {
        await new Promise(resolve => setTimeout(resolve, 450)); input.signal?.throwIfAborted();
        yield { type: "text_delta", text };
      }
    },
  });
});
const leases=new WorkspaceLeaseManager(db,"ui");
const runner=new SingleAgentRunner(db,runtimes,approvals,executionEvents,attachments,history,leases);
const supervisor=new RunSupervisor(runner);
const plan={objective:"Preview team response",summary:"Two different room members respond in dependency order; no workspace changes requested.",steps:[{id:"s",title:"Respond",description:"Return response",files:[],commands:[],risks:[],verification:["Both members responded"]}],evidence:[],workPackages:[{id:"first",title:"Ada response",objective:"First member response",input:"Respond",dependencies:[],executorAgentId:"a",reviewerAgentId:null,expectedFiles:[],acceptanceCriteria:["Return own response"]},{id:"second",title:"Babbage response",objective:"Second member response",input:"Respond after Ada",dependencies:["first"],executorAgentId:"b",reviewerAgentId:null,expectedFiles:[],acceptanceCriteria:["Return own response"]}]};
const gateway:ModelGateway=async function*(input){await new Promise(resolve=>setTimeout(resolve,300));yield {type:"delta",text:input.system?.includes("TEAM execution task")?JSON.stringify(plan):`Discussion (${input.modelId}): 有界讨论回复。`};yield {type:"done"};};
const resolveAgent=(id:string,snapshot:Record<string,unknown>)=>({id,nickname:String(snapshot.nickname),role:"",systemPrompt:"",modelId:"mock-model",providerType:"openai_compatible" as const,baseUrl:"http://mock.invalid",apiKey:"fixture-only"});
const tasks=new MultiTaskStore(db,history),coordinator=new MultiAgentCoordinator(db,tasks,events,gateway,resolveAgent,history);
const execution=new ExecutionRunner(db,tasks,runtimes,leases,approvals,events,executionEvents,history),packages=new WorkPackageStore(db);
const team=new TeamRunner(db,tasks,packages,execution,coordinator,events,history);
const commands=new RoomCommandService(db,sessions,{startDirect:input=>supervisor.start(input),getDirect:id=>supervisor.get(id),cancelDirect:id=>supervisor.cancel(id),isTeamActive:id=>team.isActive(id),resolveFileContext:(workspaceId,refs,ids)=>resolveRoomFileContext(db,workspaces,attachments,workspaceId,refs,ids),createTeam:async({sessionId,prompt,clientRequestId,targetAgentIds,inputContext})=>{const task=await coordinator.create({sessionId,prompt,config:{speakingOrder:["a","b"],maxRounds:1,synthesizerId:"a",executionAgentId:"a",teamExecution:true,clientRequestId,targetAgentIds,inputContext}});void coordinator.run(task.id);return {taskId:task.id};},resolveAgent,gateway},history);
if (process.env.SOCRATES_UI_RELIABILITY === "1") {
  sessions.create({id:"work-two",kind:"cowork",mode:"multi_agent",title:"Work two",workspaceId:workspace.id,primaryAgentId:"b",agents:members});
  for (const [id, archived] of [["legacy-chat", 0], ["legacy-archived", 1]] as const) {
    db.run("INSERT INTO rooms (id,name,archived,created_at,updated_at) VALUES (?,?,?,?,?)", [id,id,archived,now,now]);
    db.run("INSERT INTO room_agents VALUES (?, 'a', 0), (?, 'b', 1)", [id,id]);
    db.run("INSERT INTO messages (id,room_id,role,agent_id,agent_name,model,content,created_at) VALUES (?,?,'agent','a','Historical Ada','old-model','Legacy constraint: use SQLite only',?)", [`${id}-message`,id,now]);
  }
  legacyRoomSessionsMigration.up(db);
}
await history.bootstrapAll();
const app=new Hono();app.use("*",cors());app.get("/health",c=>c.json({ok:true}));
app.route("/config",configRoutes(new ConfigStore(`${root}/config.toml`,secrets)));
app.route("/providers",providerRoutes(db,secrets,(async()=>Response.json({data:[{id:"mock-model"}]})) as typeof fetch));
app.route("/agents",agentRoutes(db));app.route("/rooms",roomRoutes(db,secrets,gateway,undefined,sessions));app.get("/mcp/servers",c=>c.json([]));
app.route("/workspaces",workspaceRoutes(workspaces));app.route("/sessions",sessionRoutes(sessions,events,undefined,workspaces,undefined,template));
app.route("/agent",agentRunRoutes(supervisor,runner,approvals,executionEvents));app.route("/room-commands",roomCommandRoutes(commands));app.route("/content",contentRoutes(db,workspaces,attachments));
app.route("/multi",multiAgentRoutes(tasks,coordinator,execution,approvals,team));
const server=Bun.serve({hostname:"127.0.0.1",port:45327,idleTimeout:0,fetch:app.fetch});
console.log(JSON.stringify({port:server.port,token:"ui-validation",scratch:root}));
