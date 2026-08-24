import { describe, expect, it } from "bun:test";
import { openDb } from "../db";
import { ExecutionEventStore } from "./execution-event-store";

function setup() {
  const db = openDb(":memory:");
  db.query("INSERT INTO sessions (id, title, mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("session-1", "Test", "single_agent", "idle", "now", "now");
  return { db, store: new ExecutionEventStore(db) };
}

function insertRun(db: ReturnType<typeof openDb>, runId: string): void {
  db.query(`
    INSERT INTO agent_runs
      (id, session_id, prompt, status, created_at, turn_id, event_seq, agent_state, thread_id)
    VALUES (?, 'session-1', 'test', 'running', 'now', 'turn-1', 0, 'ready', 'thread-1')
  `).run(runId);
}

describe("ExecutionEventStore", () => {
  it("assigns an independent durable sequence to each Run and replays after a cursor", () => {
    const { store } = setup();
    store.append({
      eventId: "run-1-created",
      sessionId: "session-1",
      runId: "run-1",
      agentId: "agent-1",
      type: "run.created",
      coordinates: {},
      payload: { threadId: "thread-1", attemptNo: 1 },
    });
    store.append({
      eventId: "run-2-created",
      sessionId: "session-1",
      runId: "run-2",
      agentId: "agent-1",
      type: "run.created",
      coordinates: {},
      payload: { threadId: "thread-1", attemptNo: 1 },
    });
    store.append({
      eventId: "run-1-started",
      sessionId: "session-1",
      runId: "run-1",
      agentId: "agent-1",
      type: "run.started",
      coordinates: {},
      payload: {},
    });

    expect(store.listAfter("run-1", 1).map((item) => [item.seq, item.type]))
      .toEqual([[2, "run.started"]]);
    expect(store.listAfter("run-2", 0).map((item) => item.seq)).toEqual([1]);
  });

  it("deduplicates an identical event id and rejects conflicting reuse", () => {
    const { store } = setup();
    const input = {
      eventId: "stable-event",
      sessionId: "session-1",
      runId: "run-1",
      agentId: "agent-1",
      type: "run.started" as const,
      coordinates: {},
      payload: {},
    };
    const first = store.append(input);
    expect(store.append(input)).toEqual(first);
    expect(() => store.append({ ...input, type: "run.completed" as const }))
      .toThrow("execution_event_id_conflict");
  });

  it("commits an event and projection together", () => {
    const { db, store } = setup();
    insertRun(db, "run-1");
    expect(() => store.append({
      eventId: "failed",
      sessionId: "session-1",
      runId: "run-1",
      agentId: "agent-1",
      type: "run.started",
      coordinates: {},
      payload: {},
    }, () => {
      throw new Error("projection_failed");
    })).toThrow("projection_failed");
    expect(store.listAfter("run-1", 0)).toEqual([]);
    expect(db.query("SELECT event_seq FROM agent_runs WHERE id = 'run-1'").get())
      .toEqual({ event_seq: 0 });
  });

  it("advances the relational Run projection in the append transaction", () => {
    const { db, store } = setup();
    insertRun(db, "run-1");
    store.append({
      eventId: "run-1-started",
      sessionId: "session-1",
      runId: "run-1",
      agentId: "agent-1",
      type: "run.started",
      coordinates: { turnId: "turn-1" },
      payload: {},
    });
    expect(db.query("SELECT event_seq FROM agent_runs WHERE id = 'run-1'").get())
      .toEqual({ event_seq: 1 });
  });

  it("fails closed on an invalid identity hierarchy", () => {
    const { store } = setup();
    expect(() => store.append({
      eventId: "invalid-step",
      sessionId: "session-1",
      runId: "run-1",
      agentId: "agent-1",
      type: "step.started",
      // @ts-expect-error Exercise the runtime guard used for persisted/untrusted input.
      coordinates: { stepId: "step-1" },
      payload: {},
    })).toThrow("execution_step_requires_turn");
  });

  it("wakes a durable cursor waiter without losing an append between read and wait", async () => {
    const { db, store } = setup();
    insertRun(db, "run-1");
    store.append({
      eventId: "run-1-created",
      sessionId: "session-1",
      runId: "run-1",
      agentId: "agent-1",
      type: "run.created",
      coordinates: { turnId: "turn-1" },
      payload: { threadId: "thread-1", attemptNo: 1 },
    });
    const waiting = store.waitForAppend("run-1", 1);
    store.append({
      eventId: "run-1-completed",
      sessionId: "session-1",
      runId: "run-1",
      agentId: "agent-1",
      type: "run.completed",
      coordinates: { turnId: "turn-1" },
      payload: {},
    });
    await waiting;
    await store.waitForAppend("run-1", 1);
    expect(store.listAfter("run-1", 1).map((event) => event.seq)).toEqual([2]);
  });
});
