import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { ModelGateway, OrchestrationAgent } from "@socrates/core";
import { ApprovalManager } from "../approvals/manager";
import { openDb } from "../db";
import { MultiAgentCoordinator } from "../multi-agent/coordinator";
import { MultiTaskStore } from "../multi-agent/task-store";
import type { ExecutionRunner } from "../runtime/execution-runner";
import { EventStore } from "../store/event-store";
import { multiAgentRoutes } from "./multi-agent";

function setup() {
  const db = openDb(":memory:");
  const now = new Date().toISOString();
  db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES ('w', '/tmp', '/tmp', 'hash', 'tmp', ?, ?)").run(now, now);
  db.query("INSERT INTO sessions (id, title, mode, workspace_id, status, created_at, updated_at) VALUES ('s', 'multi', 'multi_agent', 'w', 'idle', ?, ?)").run(now, now);
  for (const [position, id] of ["a", "b"].entries()) db.query("INSERT INTO session_agents (session_id, agent_id, snapshot_json, position, execution_eligible) VALUES ('s', ?, ?, ?, 1)").run(id, JSON.stringify({ nickname: id, modelId: `model-${id}` }), position);
  const valid = JSON.stringify({ objective: "build", summary: "safe", steps: [{ id: "1", title: "edit", description: "change", files: ["src/a.ts"], commands: [], risks: [], verification: ["bun test"] }], evidence: [] });
  let calls = 0;
  const gateway: ModelGateway = async function* () { calls += 1; yield { type: "delta", text: calls === 3 ? valid : `view-${calls}` }; yield { type: "done" }; };
  const resolve = (id: string, snapshot: Record<string, unknown>): OrchestrationAgent => ({ id, nickname: String(snapshot.nickname), modelId: String(snapshot.modelId), role: "", systemPrompt: "", providerType: "openai_compatible", baseUrl: "http://unused", apiKey: "fixture" });
  const store = new MultiTaskStore(db);
  const coordinator = new MultiAgentCoordinator(db, store, new EventStore(db), gateway, resolve);
  let executions = 0;
  const execution = { run: async () => { executions += 1; }, decide: async () => { throw new Error("unused"); }, cancel: async () => {} } as unknown as ExecutionRunner;
  const app = new Hono().route("/multi", multiAgentRoutes(store, coordinator, execution, new ApprovalManager(db)));
  return { app, executions: () => executions };
}

describe("multi-agent routes", () => {
  it("streams discussion to a durable plan and starts execution only once for an exact decision", async () => {
    const { app, executions } = setup();
    const response = await app.request("/multi/sessions/s/tasks", { method: "POST", body: JSON.stringify({ prompt: "build", config: { speakingOrder: ["a", "b"], maxRounds: 1, synthesizerId: "b", executionAgentId: "a" } }) });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("plan_ready");
    const tasks = await (await app.request("/multi/sessions/s/tasks")).json() as Array<{ id: string }>;
    const view = await (await app.request(`/multi/tasks/${tasks[0]!.id}`)).json() as { plan: { version: number; contentHash: string }; state: string };
    expect(view.state).toBe("awaiting_plan_approval");
    const wrong = await app.request(`/multi/tasks/${tasks[0]!.id}/plan-decisions`, { method: "POST", body: JSON.stringify({ version: view.plan.version, hash: "wrong", clientDecisionKey: "wrong", decision: "approve_exact_plan" }) });
    expect(wrong.status).toBe(409);
    const body = JSON.stringify({ version: view.plan.version, hash: view.plan.contentHash, clientDecisionKey: "approve", decision: "approve_exact_plan" });
    expect((await app.request(`/multi/tasks/${tasks[0]!.id}/plan-decisions`, { method: "POST", body })).status).toBe(200);
    expect((await app.request(`/multi/tasks/${tasks[0]!.id}/plan-decisions`, { method: "POST", body })).status).toBe(200);
    await Bun.sleep(1);
    expect(executions()).toBe(1);
  });

  it("never executes a rejected plan", async () => {
    const { app, executions } = setup();
    const response = await app.request("/multi/sessions/s/tasks", { method: "POST", body: JSON.stringify({ prompt: "build", config: { speakingOrder: ["a", "b"], maxRounds: 1, synthesizerId: "b", executionAgentId: "a" } }) });
    await response.text();
    const tasks = await (await app.request("/multi/sessions/s/tasks")).json() as Array<{ id: string }>;
    const view = await (await app.request(`/multi/tasks/${tasks[0]!.id}`)).json() as { plan: { version: number; contentHash: string } };
    const rejected = await app.request(`/multi/tasks/${tasks[0]!.id}/plan-decisions`, { method: "POST", body: JSON.stringify({ version: view.plan.version, hash: view.plan.contentHash, clientDecisionKey: "reject", decision: "reject" }) });
    expect(rejected.status).toBe(200);
    expect((await (await app.request(`/multi/tasks/${tasks[0]!.id}`)).json()).state).toBe("cancelled");
    expect(executions()).toBe(0);
  });
});
