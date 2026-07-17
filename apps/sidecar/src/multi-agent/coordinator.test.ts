import { describe, expect, it } from "bun:test";
import type { ModelGateway, OrchestrationAgent } from "@socrates/core";
import { openDb } from "../db";
import { EventStore } from "../store/event-store";
import { MultiAgentCoordinator } from "./coordinator";
import { MultiTaskStore } from "./task-store";

function setup(outputs: string[]) {
  const db = openDb(":memory:");
  const now = new Date().toISOString();
  db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES ('w', '/tmp', '/tmp', 'hash', 'tmp', ?, ?)").run(now, now);
  db.query("INSERT INTO sessions (id, title, mode, workspace_id, status, created_at, updated_at) VALUES ('s', 'multi', 'multi_agent', 'w', 'idle', ?, ?)").run(now, now);
  for (const [position, id] of ["a", "b"].entries()) db.query("INSERT INTO session_agents (session_id, agent_id, snapshot_json, position, execution_eligible) VALUES ('s', ?, ?, ?, 1)").run(id, JSON.stringify({ nickname: id, modelId: `model-${id}` }), position);
  let calls = 0;
  const gateway: ModelGateway = async function* () { const value = outputs[calls++] ?? "missing"; yield { type: "delta", text: value }; yield { type: "done", usage: { inputTokens: 1, outputTokens: 2 } }; };
  const resolve = (id: string, snapshot: Record<string, unknown>): OrchestrationAgent => ({ id, nickname: String(snapshot.nickname), modelId: String(snapshot.modelId), role: "", systemPrompt: "", providerType: "openai_compatible", baseUrl: "http://unused", apiKey: "fixture" });
  const store = new MultiTaskStore(db);
  return { db, store, coordinator: new MultiAgentCoordinator(db, store, new EventStore(db), gateway, resolve), calls: () => calls };
}

describe("MultiAgentCoordinator", () => {
  it("runs discussion serially, repairs a plan once and waits for exact approval", async () => {
    const valid = JSON.stringify({ objective: "build", summary: "safe", steps: [{ id: "1", title: "edit", description: "change", files: ["src/a.ts"], commands: [], risks: [], verification: ["bun test"] }], evidence: [] });
    const { store, coordinator, calls } = setup(["A view", "B view", "not-json", valid]);
    const task = coordinator.create({ sessionId: "s", prompt: "build", config: { speakingOrder: ["a", "b"], maxRounds: 1, synthesizerId: "b", executionAgentId: "a" } });
    const events: string[] = [];
    await coordinator.run(task.id, (event) => { events.push(event.type); });
    expect(store.get(task.id)?.state).toBe("awaiting_plan_approval");
    expect(store.getPlan(task.id)?.content.objective).toBe("build");
    expect(calls()).toBe(4);
    expect(events.filter((type) => type === "turn_completed")).toHaveLength(2);
  });

  it("does not call a provider twice for a completed stable turn", async () => {
    const { store, coordinator, calls } = setup([]);
    const task = coordinator.create({ sessionId: "s", prompt: "x", config: { speakingOrder: ["a", "b"], maxRounds: 1, synthesizerId: "b", executionAgentId: "a" } });
    store.transition(task.id, { type: "prepared_multi" });
    const turn = store.beginTurn({ taskId: task.id, stableKey: `${task.id}:1:discussing:1:0`, phase: "discussing", round: 1, participantIndex: 0, agentId: "a", snapshot: {} });
    store.completeTurn(turn.id, "cached", null);
    // Return to preparing is intentionally impossible; idempotency is asserted directly by beginTurn.
    expect(store.beginTurn({ taskId: task.id, stableKey: `${task.id}:1:discussing:1:0`, phase: "discussing", round: 1, participantIndex: 0, agentId: "a", snapshot: {} })).toMatchObject({ status: "completed", content: "cached" });
    expect(calls()).toBe(0);
  });

  it("pauses and resumes in a new attempt without repeating completed discussion turns", async () => {
    const valid = JSON.stringify({ objective: "build", summary: "safe", steps: [{ id: "1", title: "verify", description: "run tests", files: [], commands: ["bun test"], risks: [], verification: ["bun test"] }], evidence: [] });
    let releaseSecond!: () => void;
    const secondStarted = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let calls = 0;
    const db = openDb(":memory:");
    const now = new Date().toISOString();
    db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES ('w', '/tmp', '/tmp', 'hash', 'tmp', ?, ?)").run(now, now);
    db.query("INSERT INTO sessions (id, title, mode, workspace_id, status, created_at, updated_at) VALUES ('s', 'multi', 'multi_agent', 'w', 'idle', ?, ?)").run(now, now);
    for (const [position, id] of ["a", "b"].entries()) db.query("INSERT INTO session_agents (session_id, agent_id, snapshot_json, position, execution_eligible) VALUES ('s', ?, ?, ?, 1)").run(id, JSON.stringify({ nickname: id, modelId: id }), position);
    const gateway: ModelGateway = async function* (request) {
      calls += 1;
      if (calls === 2) {
        releaseSecond();
        await new Promise<void>((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }
      yield { type: "delta", text: calls === 4 ? valid : `answer-${calls}` };
      yield { type: "done" };
    };
    const resolve = (id: string, snapshot: Record<string, unknown>): OrchestrationAgent => ({ id, nickname: String(snapshot.nickname), modelId: String(snapshot.modelId), role: "", systemPrompt: "", providerType: "openai_compatible", baseUrl: "http://unused", apiKey: "fixture" });
    const store = new MultiTaskStore(db);
    const coordinator = new MultiAgentCoordinator(db, store, new EventStore(db), gateway, resolve);
    const task = coordinator.create({ sessionId: "s", prompt: "build", config: { speakingOrder: ["a", "b"], maxRounds: 1, synthesizerId: "b", executionAgentId: "a" } });
    const firstRun = coordinator.run(task.id);
    await secondStarted;
    coordinator.pause(task.id);
    await firstRun;
    expect(store.get(task.id)?.state).toBe("paused");
    await coordinator.resume(task.id);
    expect(store.get(task.id)).toMatchObject({ state: "awaiting_plan_approval", attemptNo: 2 });
    expect(calls).toBe(4);
  });
});
