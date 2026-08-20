import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../migrations";
import { ExecutionEventStore } from "../execution-event-store";
import { migrations } from "./index";

describe("017 execution event authority migration", () => {
  it("preserves a legacy runtime event and adds execution identity metadata", () => {
    const db = new Database(":memory:");
    runMigrations(db, migrations.slice(0, 16));
    db.query("INSERT INTO sessions (id, title, mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("session-1", "Test", "single_agent", "idle", "now", "now");
    db.query(`INSERT INTO agent_runs
      (id, session_id, prompt, status, created_at, turn_id, event_seq, agent_state, thread_id, attempt_no)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("run-1", "session-1", "test", "completed", "now", "turn-1", 0, "completed", "thread-1", 1);
    db.query(`INSERT INTO runtime_events
      (id, run_id, turn_id, agent_id, seq, type, payload_json, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("legacy-1", "run-1", "turn-1", "agent-1", 1, "runtime.status", "{}", "now");

    expect(runMigrations(db, migrations)).toEqual([17]);
    expect(db.query(`SELECT session_id, schema_version, step_id, provider_attempt_id,
      tool_operation_id, tool_attempt_id FROM runtime_events WHERE id = 'legacy-1'`).get())
      .toEqual({
        session_id: "session-1",
        schema_version: 0,
        step_id: null,
        provider_attempt_id: null,
        tool_operation_id: null,
        tool_attempt_id: null,
      });
    expect(db.query("SELECT event_seq FROM agent_runs WHERE id = 'run-1'").get())
      .toEqual({ event_seq: 1 });
    const store = new ExecutionEventStore(db);
    expect(store.listAfter("run-1", 0)).toEqual([]);
    expect(() => store.append({
      eventId: "new-v1-on-legacy-run",
      sessionId: "session-1",
      runId: "run-1",
      agentId: "agent-1",
      type: "run.interrupted",
      coordinates: { turnId: "turn-1" },
      payload: { reason: "migration" },
    })).toThrow("execution_event_legacy_run_quarantined");
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_projection_checkpoints'").get())
      .toEqual({ name: "runtime_projection_checkpoints" });
  });
});
