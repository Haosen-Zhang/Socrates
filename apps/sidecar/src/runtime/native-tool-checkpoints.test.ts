import { expect, it } from "bun:test";
import type { ToolDefinition } from "@socrates/core";
import { openDb } from "../db";
import { ApprovalManager } from "../approvals/manager";
import { ExecutionEventStore } from "../store/execution-event-store";
import { ToolExecutor } from "../tools/executor";
import { ToolExecutionJournal } from "../tools/execution-journal";
import { ToolRegistry } from "../tools/registry";
import { NativeAgentRuntime, type NativeStreamFactory } from "./native-agent-runtime";
import { RuntimeManager } from "./runtime-manager";

function setup(stream: NativeStreamFactory) {
  const db = openDb(":memory:");
  db.query("INSERT INTO sessions (id, title, mode, status, created_at, updated_at) VALUES ('s', 'S', 'single_agent', 'idle', 'now', 'now')").run();
  let effects = 0;
  const definition: ToolDefinition = { name: "write", description: "write", generation: 1,
    inputSchema: { type: "object", properties: {} }, capability: "workspace_write", risk: "high", idempotency: "non_idempotent",
    async execute() { effects++; return "done"; } };
  const registry = new ToolRegistry([definition]);
  const events = new ExecutionEventStore(db);
  const executor = new ToolExecutor(db, registry, new ApprovalManager(db));
  const runtime = new NativeAgentRuntime({ sessionId: "s", taskId: "agent-session", agentId: "a", workspaceId: "w", workspaceIdentity: "w",
    registry, executor, stream, allowedCapabilities: ["workspace_write"],
    permissionForTool: () => ({ effect: "allow", risk: "high", matchedRuleIds: [], reasonCode: "room_allow", freshHumanRequired: false, policyVersion: 1 }),
  });
  const manager = new RuntimeManager(db, events);
  manager.register("native", () => runtime);
  return { db, events, executor, manager, runtime, effects: () => effects };
}

it("binds tool execution to the real Run/Turn/Step even when SDK execution is eager", async () => {
  const s = setup(async function* ({ tools }) {
    yield { type: "provider_attempt_started", attemptNo: 1 };
    await tools.write!.execute({}, "c", tools.write!.permission());
    yield { type: "provider_attempt_completed", attemptNo: 1 };
    yield { type: "provider_step_completed" };
  });
  const handle = await s.manager.open({ runtimeKind: "native", agentSessionId: "as", sessionId: "s", agentId: "a" });
  await s.manager.run(handle.id, { taskId: "run", turnId: "turn", prompt: "write" });
  const event = s.events.listAfter("run", 0).find((item) => item.type === "tool.attempt.started");
  expect(event?.coordinates).toMatchObject({ turnId: "turn", stepId: "run:turn:turn:step:1", toolOperationId: expect.stringMatching(/^native-tool-v1:[a-f0-9]{64}$/) });
  expect(s.db.query("SELECT task_id, turn_id FROM tool_calls").get()).toEqual({ task_id: "run", turn_id: "turn" });
});

it("stops sampling after result journal failure even if a stream treats it as a tool error", async () => {
  let nextSample = false;
  const s = setup(async function* ({ tools }) {
    yield { type: "provider_attempt_started", attemptNo: 1 };
    try { await tools.write!.execute({}, "c", tools.write!.permission()); } catch { /* SDK normalizes tool exceptions. */ }
    yield { type: "provider_attempt_completed", attemptNo: 1 };
    yield { type: "provider_step_completed" };
    yield { type: "provider_attempt_started", attemptNo: 1 };
    nextSample = true;
    yield { type: "provider_attempt_completed", attemptNo: 1 };
    yield { type: "provider_step_completed" };
  });
  s.db.exec(`CREATE TRIGGER fail_result BEFORE INSERT ON tool_outputs BEGIN SELECT RAISE(ABORT, 'disk_full'); END`);
  const handle = await s.manager.open({ runtimeKind: "native", agentSessionId: "as", sessionId: "s", agentId: "a" });
  await expect(s.manager.run(handle.id, { taskId: "run", turnId: "turn", prompt: "write" })).rejects.toThrow();
  expect(nextSample).toBe(false);
  expect(s.effects()).toBe(1);
});

it("requires fresh approval for an unknown mutation despite a room allow policy", async () => {
  let effect: string | undefined;
  const s = setup(async function* ({ tools }) {
    effect = tools.write!.permission().effect;
    yield { type: "text_delta", text: "inspect first" };
  });
  s.db.query(`INSERT INTO tool_calls (id, stable_key, session_id, task_id, attempt_id, turn_id, agent_id, name,
    generation, input_json, input_hash, workspace_identity, policy_version, risk, idempotency, status, capability, created_at, updated_at)
    VALUES ('old', 'old', 's', 'old-run', 'old-run', 'old-turn', 'a', 'write', 1, '{}', 'hash', 'w', 1, 'high', 'non_idempotent', 'running', 'workspace_write', 'now', 'now')`).run();
  new ToolExecutionJournal(s.db).recoverInterrupted();
  const handle = await s.manager.open({ runtimeKind: "native", agentSessionId: "as", sessionId: "s", agentId: "a" });
  await s.manager.run(handle.id, { taskId: "run", turnId: "turn", prompt: "continue" });
  expect(effect).toBe("ask");
  expect(s.effects()).toBe(0);
});

it('deferred approved SDK execution retains its original operation and provider step',async()=>{
 const s=setup(async function*({tools,requestApproval}){yield {type:'provider_attempt_started',attemptNo:1};const permission={...tools.write!.permission(),effect:'ask' as const};yield {type:'tool_call',callId:'shared',name:'write',input:{}};const request={requestId:'approve-deferred',callId:'shared',name:'write',input:{},permission};const granted=requestApproval(request);yield {type:'approval_required',...request};await granted;yield {type:'provider_attempt_completed',attemptNo:1};yield {type:'provider_step_completed'};yield {type:'provider_attempt_started',attemptNo:1};const output=await tools.write!.execute({},'shared',permission);yield {type:'tool_result',callId:'shared',name:'write',output,isError:false};yield {type:'provider_attempt_completed',attemptNo:1};yield {type:'provider_step_completed'};});
 const handle=await s.manager.open({runtimeKind:'native',agentSessionId:'as',sessionId:'s',agentId:'a'});let requested:string|undefined,resultId:string|undefined;await s.manager.run(handle.id,{taskId:'run',turnId:'turn',prompt:'controlled',onEvent:async event=>{if(event.type==='tool_call'){requested=event.callId;expect(event.providerCallId).toBe('shared');}if(event.type==='approval_required')await s.runtime.answerApproval(event.requestId,'allow_once');if(event.type==='tool_result'){resultId=event.callId;expect(event.providerCallId).toBe('shared');}}});expect(resultId).toBe(requested);expect(s.events.listAfter('run',0).find(e=>e.type==='tool.attempt.started')?.coordinates).toMatchObject({toolOperationId:requested,stepId:'run:turn:turn:step:1'});expect(s.effects()).toBe(1);s.db.close();
});
