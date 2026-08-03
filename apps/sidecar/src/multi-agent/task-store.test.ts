import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db";
import { HistoryStore } from "../store/history-store";
import { MultiTaskStore } from "./task-store";

function setup() {
  const db = openDb(":memory:");
  const now = new Date().toISOString();
  db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES ('w', '/tmp', '/tmp', 'hash', 'tmp', ?, ?)").run(now, now);
  db.query("INSERT INTO sessions (id, title, mode, workspace_id, status, created_at, updated_at) VALUES ('s', 'multi', 'multi_agent', 'w', 'idle', ?, ?)").run(now, now);
  for (const [position, id] of ["a", "b"].entries()) db.query("INSERT INTO session_agents (session_id, agent_id, snapshot_json, position, execution_eligible) VALUES ('s', ?, ?, ?, 1)").run(id, JSON.stringify({ nickname: id }), position);
  return { db, store: new MultiTaskStore(db) };
}

describe("MultiTaskStore", () => {
  it("updates state only through the reducer and deduplicates stable turns", async () => {
    const { store } = setup();
    const task = await store.create({ sessionId: "s", prompt: "build", config: { speakingOrder: ["a", "b"], maxRounds: 1, synthesizerId: "b", executionAgentId: "a" } });
    expect(store.transition(task.id, { type: "prepared_multi" }).state).toBe("discussing");
    const turn = store.beginTurn({ taskId: task.id, stableKey: `${task.id}:1:discussing:1:0`, phase: "discussing", round: 1, participantIndex: 0, agentId: "a", snapshot: { nickname: "a" } });
    store.completeTurn(turn.id, "answer", { inputTokens: 2 });
    expect(store.beginTurn({ taskId: task.id, stableKey: `${task.id}:1:discussing:1:0`, phase: "discussing", round: 1, participantIndex: 0, agentId: "a", snapshot: {} })).toMatchObject({ status: "completed", content: "answer" });
    expect(() => store.transition(task.id, { type: "approve_plan" })).toThrow("invalid_task_transition");
    expect(store.get(task.id)?.state).toBe("discussing");
  });

  it("binds an idempotent decision to the exact plan hash", async () => {
    const { store } = setup();
    const task = await store.create({ sessionId: "s", prompt: "build", config: { speakingOrder: ["a", "b"], maxRounds: 1, synthesizerId: "b", executionAgentId: "a" } });
    store.transition(task.id, { type: "prepared_multi" });
    store.transition(task.id, { type: "discussion_complete" });
    const plan = await store.addPlan({ taskId: task.id, createdBy: "b", content: { objective: "build", summary: "safe", steps: [{ id: "1", title: "edit", description: "change", files: ["a.ts"], commands: [], risks: [], verification: ["test"] }], evidence: [] } });
    store.transition(task.id, { type: "plan_ready" });
    expect(() => store.decidePlan({ taskId: task.id, version: plan.version, hash: "wrong", clientDecisionKey: "d", decision: "approve_exact_plan" })).toThrow("plan_hash_mismatch");
    const decision = store.decidePlan({ taskId: task.id, version: plan.version, hash: plan.contentHash, clientDecisionKey: "d", decision: "approve_exact_plan" });
    expect(decision.replayed).toBe(false);
    expect(store.decidePlan({ taskId: task.id, version: plan.version, hash: plan.contentHash, clientDecisionKey: "d", decision: "approve_exact_plan" })).toMatchObject({ id: decision.id, replayed: true });
    expect(store.get(task.id)).toMatchObject({ state: "executing", approvedPlanHash: plan.contentHash });
  });

  it("opens a new attempt on resume and reuses completed logical turns", async () => {
    const { db, store } = setup();
    const task = await store.create({ sessionId: "s", prompt: "build", config: { speakingOrder: ["a", "b"], maxRounds: 1, synthesizerId: "b", executionAgentId: "a" } });
    store.transition(task.id, { type: "prepared_multi" });
    const turn = store.beginTurn({ taskId: task.id, stableKey: `${task.id}:1:discussing:1:0`, phase: "discussing", round: 1, participantIndex: 0, agentId: "a", snapshot: {} });
    store.completeTurn(turn.id, "durable answer", { outputTokens: 3 });
    store.transition(task.id, { type: "pause" });
    expect(store.resumeNewAttempt(task.id)).toMatchObject({ state: "discussing", attemptNo: 2 });
    expect(store.completedLogicalTurn({ taskId: task.id, phase: "discussing", round: 1, participantIndex: 0, agentId: "a" })).toMatchObject({ content: "durable answer" });
    expect(db.query("SELECT status FROM multi_task_attempts WHERE task_id = ? ORDER BY attempt_no").all(task.id)).toEqual([{ status: "paused" }, { status: "active" }]);
  });

  it("does not blindly resume an outcome-unknown provider turn", async () => {
    const { store } = setup();
    const task = await store.create({ sessionId: "s", prompt: "build", config: { speakingOrder: ["a", "b"], maxRounds: 1, synthesizerId: "b", executionAgentId: "a" } });
    store.transition(task.id, { type: "prepared_multi" });
    const turn = store.beginTurn({ taskId: task.id, stableKey: `${task.id}:1:discussing:1:0`, phase: "discussing", round: 1, participantIndex: 0, agentId: "a", snapshot: {} });
    store.failTurn(turn.id, "transport_lost_after_send", "unknown");
    store.transition(task.id, { type: "pause" });
    expect(() => store.resumeNewAttempt(task.id)).toThrow("multi_task_outcome_unknown_requires_review");
    expect(store.get(task.id)).toMatchObject({ state: "paused", attemptNo: 1 });
    expect(store.resumeNewAttempt(task.id, { allowOutcomeUnknown: true })).toMatchObject({ state: "discussing", attemptNo: 2 });
  });

  it("replays task creation projection after a sidecar restart", async () => {
    const { db } = setup();
    const dir = mkdtempSync(join(tmpdir(), "socrates-multi-history-"));
    try {
      db.query(`INSERT INTO conversation_threads
        (id, room_id, is_default, latest_sequence, created_at, updated_at)
        VALUES ('thread:s', 's', 1, 0, 'now', 'now')`).run();
      const history = new HistoryStore(db, dir);
      const store = new MultiTaskStore(db, history);
      db.exec(`CREATE TRIGGER fail_multi_projection BEFORE INSERT ON multi_tasks
        BEGIN SELECT RAISE(ABORT, 'injected_multi_projection_failure'); END`);
      await expect(store.create({
        sessionId: "s", prompt: "survive", config: {
          speakingOrder: ["a", "b"], maxRounds: 1, synthesizerId: "b", executionAgentId: "a",
        },
      })).rejects.toThrow("injected_multi_projection_failure");
      db.exec("DROP TRIGGER fail_multi_projection");

      const restartedHistory = new HistoryStore(db, dir);
      new MultiTaskStore(db, restartedHistory);
      await restartedHistory.bootstrapSession("s");
      expect(db.query("SELECT prompt FROM multi_tasks").all()).toEqual([{ prompt: "survive" }]);
      expect(db.query("SELECT status FROM multi_task_attempts").all()).toEqual([{ status: "active" }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
