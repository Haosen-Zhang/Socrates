import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { AdaptiveAttempt, GatewayInvocationContext, GatewayRequest, RoomCollaborationSettings } from "@socrates/core";
import { openDb } from "../db";
import { SessionStore } from "../store/session-store";
import { WorkspaceManager } from "../workspace/manager";
import { RoutePolicyService } from "./route-policy";
import { ModelInvocationBroker } from "./model-invocation-broker";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(close => close()));

function setup(options: { customDiscussion?: boolean; maxCalls?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "socrates-routing-broker-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "README.md"), "Controlled scope");
  const db = openDb(":memory:"); cleanup.push(() => db.close());
  db.query("INSERT INTO providers(id,name,type,base_url,api_key_ref,created_at,updated_at) VALUES ('p','Fixture','openai_compatible','https://fixture.invalid/v1','unused','now','now')").run();
  const sessions = new SessionStore(db), workspace = new WorkspaceManager(db).select(directory);
  const room = sessions.create({ title: "Routing broker fixture", mode: "multi_agent", workspaceId: workspace.id, primaryAgentId: "a",
    agents: ["a", "b", "c"].map(agentId => ({ agentId, executionEligible: true, snapshot: { providerId: "p", modelId: agentId,
      nickname: agentId, configurationVersion: "fixture-v1", modelCapabilities: { textInput: true, toolCalling: true, contextWindowTokens: 128000, runtimeKinds: ["native"], reasoningEfforts: ["auto"] } } })) });
  const collaboration: RoomCollaborationSettings = { ...room.collaboration, strategy: options.customDiscussion ? "team" : "adaptive",
    assignment: { ...room.collaboration.assignment, coordinatorAgentId: "a", callableAgentIds: [], routing: { ...room.collaboration.assignment.routing,
      mode: options.customDiscussion ? "manual" : "automatic", automaticPolicy: "cost", lightweightAgentId: "b",
      limits: { maxRetries: 0, maxEscalations: 0, maxTotalModelCalls: options.maxCalls ?? 24 } } },
    discussion: { ...room.collaboration.discussion, enabled: !!options.customDiscussion, speakerOrder: ["a", "c"], summaryAgentId: "a", maxRounds: 1 } };
  db.query("UPDATE sessions SET collaboration_json=? WHERE id=?").run(JSON.stringify(collaboration), room.id);
  const broker = new ModelInvocationBroker(db);
  for (const id of ["a", "b", "c"]) broker.prices.save({ providerConnectionId: "p", modelId: id, protocol: "openai_chat_completions", baseUrl: "https://fixture.invalid/v1",
    currency: "USD", rates: { input: id === "b" ? "1" : "2", output: id === "b" ? "1" : "2" }, source: "user_confirmed", sourceVersion: "fixture/1" });
  const routes = new RoutePolicyService(db, sessions, { hasCredentials: () => true });
  const input = { roomId: room.id, content: "Update README.md", intent: "execute" as const, mentions: [], maxOutputTokens: 100 };
  const preview = routes.preview(input);
  expect(preview.selected).not.toBeNull();
  db.query("INSERT INTO room_commands(id,room_id,client_request_id,fingerprint,input_json,kind,status,created_at,updated_at) VALUES ('root',?,'fixture','fixture',?,'direct','running','now','now')")
    .run(room.id, JSON.stringify(input));
  const decision = routes.freeze("root", preview, null);
  db.query("INSERT INTO adaptive_workflows(root_task_id,room_id,decision_id,status,state_json,created_at,updated_at) VALUES ('root',?,?,'running','{}','now','now')").run(room.id, decision.id);
  const attempt: AdaptiveAttempt = { id: "attempt", rootTaskId: "root", ordinal: 1, clientTurnKey: "fixture", decisionId: decision.id,
    candidateId: decision.selected!.id, workflow: decision.selected!.workflow, assignments: decision.selected!.assignments,
    kind: "initial", status: "running", child: null, handoff: null, estimatedAdditionalCost: { currency: "USD", lowAtomic: decision.selected!.lowAtomic, highAtomic: decision.selected!.highAtomic },
    createdAt: "now", startedAt: "now", finishedAt: null };
  saveAttempt(db, attempt);
  broker.budgets.create({ rootTaskId: "root", roomId: room.id, mode: "soft_limit", limitAtomic: "1000000000000" });
  const request = (agentId = "b", purpose: GatewayInvocationContext["purpose"] = "execute"): GatewayRequest => ({ providerType: "openai_compatible", baseUrl: "https://fixture.invalid/v1", apiKey: "unused-fixture",
    modelId: agentId, maxOutputTokens: 100, messages: [{ role: "user", content: "Synthetic request" }], invocation: { roomId: room.id, rootTaskId: "root", runId: "run", routeAttemptId: "attempt",
      agentId, purpose, providerConnectionId: "p", runProfileVersion: "fixture-v1", logicalStepId: "step" } });
  return { db, broker, routes, room, decision, collaboration, attempt, request };
}
function saveAttempt(db: Database, attempt: AdaptiveAttempt) {
  db.query("INSERT OR REPLACE INTO adaptive_attempts(id,root_task_id,ordinal,status,attempt_json) VALUES (?,?,?,?,?)")
    .run(attempt.id, attempt.rootTaskId, attempt.ordinal, attempt.status, JSON.stringify(attempt));
}
async function drain<T>(events: AsyncIterable<T>) { for await (const _event of events) { /* consume the physical call */ } }

test("empty callable pool retains every room member and frozen pricing survives new rates", async () => {
  const f = setup(); let calls = 0;
  const gateway = f.broker.wrapGateway(async function* () { calls++; yield { type: "done", usage: { inputTokens: 100, outputTokens: 20 } }; });
  await drain(gateway(f.request()));
  const price = f.decision.members.b!.price!;
  f.broker.prices.save({ ...price, rates: { input: "100", output: "100" }, sourceVersion: "new-current-rate" });
  await drain(gateway(f.request()));
  expect(calls).toBe(2);
  const facts = f.broker.ledger.list({ rootTaskId: "root" });
  expect(facts.map(fact => fact.priceSnapshotId)).toEqual([price.id, price.id]);
  expect(facts.map(fact => fact.amount?.atomic)).toEqual(["120000000", "120000000"]);
});

test("Custom discussion admits only the frozen speakers and its designated summary member", async () => {
  const f = setup({ customDiscussion: true }); const seen: string[] = [];
  const gateway = f.broker.wrapGateway(async function* (request) { seen.push(`${request.invocation!.agentId}:${request.invocation!.purpose}`); yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }; });
  await drain(gateway(f.request("c", "respond")));
  await drain(gateway(f.request("a", "summarize")));
  await expect(drain(gateway(f.request("b", "respond")))).rejects.toThrow("routing_assignment_mismatch");
  await expect(drain(gateway(f.request("c", "summarize")))).rejects.toThrow("routing_assignment_mismatch");
  await expect(drain(gateway(f.request("c", "execute")))).rejects.toThrow("routing_assignment_mismatch");
  f.db.query("UPDATE session_agents SET execution_eligible=0 WHERE session_id=? AND agent_id='c'").run(f.room.id);
  await expect(drain(gateway(f.request("c", "respond")))).rejects.toThrow("routing_member_revoked");
  expect(seen).toEqual(["c:respond", "a:summarize"]);
});

test("concurrent requests reserve the final physical-call slot atomically", async () => {
  const f = setup({ maxCalls: 1 }); let calls = 0, release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const gateway = f.broker.wrapGateway(async function* () { calls++; await hold; yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }; });
  const first = drain(gateway(f.request()));
  await expect(drain(gateway(f.request()))).rejects.toThrow("routing_model_call_limit");
  release(); await first;
  expect(calls).toBe(1); expect(f.broker.ledger.list({ rootTaskId: "root" })).toHaveLength(1);
});

test("revoked room pool, egress, execution permission and workspace stop the next call", async () => {
  const f = setup(); let calls = 0;
  const gateway = f.broker.wrapGateway(async function* () { calls++; yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }; });
  const settings = (value: RoomCollaborationSettings) => f.db.query("UPDATE sessions SET collaboration_json=? WHERE id=?").run(JSON.stringify(value), f.room.id);
  settings({ ...f.collaboration, assignment: { ...f.collaboration.assignment, callableAgentIds: ["a"] } });
  await expect(drain(gateway(f.request()))).rejects.toThrow("routing_member_revoked");
  settings({ ...f.collaboration, assignment: { ...f.collaboration.assignment, routing: { ...f.collaboration.assignment.routing, allowedProviderIds: [] } } });
  await expect(drain(gateway(f.request()))).rejects.toThrow("routing_egress_revoked");
  settings(f.collaboration);
  f.db.query("UPDATE session_agents SET execution_eligible=0 WHERE session_id=? AND agent_id='b'").run(f.room.id);
  await expect(drain(gateway(f.request()))).rejects.toThrow("invocation_execution_revoked");
  f.db.query("UPDATE session_agents SET execution_eligible=1 WHERE session_id=? AND agent_id='b'").run(f.room.id);
  f.db.query("UPDATE sessions SET workspace_id=NULL WHERE id=?").run(f.room.id);
  await expect(drain(gateway(f.request()))).rejects.toThrow("routing_workspace_changed");
  expect(calls).toBe(0); expect(f.broker.ledger.list({ rootTaskId: "root" })).toHaveLength(0);
});

test("frozen role, profile and active attempt are checked before opening transport", async () => {
  const f = setup(); let calls = 0;
  const gateway = f.broker.wrapGateway(async function* () { calls++; yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }; });
  await expect(drain(gateway(f.request("a", "execute")))).rejects.toThrow("routing_assignment_mismatch");
  await expect(drain(gateway(f.request("b", "plan")))).rejects.toThrow("routing_assignment_mismatch");
  const wrong = f.request(); wrong.invocation!.runProfileVersion = "changed-profile";
  await expect(drain(gateway(wrong))).rejects.toThrow("routing_frozen_identity_mismatch");
  const noAttempt = f.request(); delete noAttempt.invocation!.routeAttemptId;
  await expect(drain(gateway(noAttempt))).rejects.toThrow("routing_attempt_missing");
  saveAttempt(f.db, { ...f.attempt, status: "cancelled" });
  await expect(drain(gateway(f.request()))).rejects.toThrow("routing_attempt_not_active");
  expect(calls).toBe(0); expect(f.broker.ledger.list({ rootTaskId: "root" })).toHaveLength(0);
});
