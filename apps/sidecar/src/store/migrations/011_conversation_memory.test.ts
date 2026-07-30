import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../migrations";
import { migrations } from "./index";

describe("011 conversation memory migration", () => {
  it("backfills a stable default thread, strict sequences, and one explicit primary Agent", () => {
    const db = new Database(":memory:");
    runMigrations(db, migrations.slice(0, 10));
    const now = "2026-07-30T00:00:00.000Z";
    db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, archived, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)")
      .run("w", "/tmp/w", "/tmp/w", "hash", "W", now, now);
    db.query("INSERT INTO sessions (id, title, mode, kind, workspace_id, archived, status, created_at, updated_at) VALUES (?, ?, 'single_agent', 'cowork', ?, 0, 'idle', ?, ?)")
      .run("s", "Session", "w", now, now);
    db.query("INSERT INTO session_agents (session_id, agent_id, snapshot_json, position, execution_eligible) VALUES ('s', 'secondary', '{}', 0, 0)").run();
    db.query("INSERT INTO session_agents (session_id, agent_id, snapshot_json, position, execution_eligible) VALUES ('s', 'primary', '{}', 1, 1)").run();
    db.query("INSERT INTO session_messages (id, session_id, role, author_id, content, status, created_at) VALUES ('m2', 's', 'assistant', 'primary', 'answer', 'completed', ?)")
      .run(now);
    db.query("INSERT INTO session_messages (id, session_id, role, content, status, created_at) VALUES ('m1', 's', 'user', 'question', 'completed', ?)")
      .run(now);

    expect(runMigrations(db, migrations)).toEqual([11]);
    expect(db.query("SELECT primary_agent_id FROM sessions WHERE id = 's'").get()).toEqual({ primary_agent_id: "primary" });
    expect(db.query("SELECT id, room_id, latest_sequence FROM conversation_threads WHERE room_id = 's'").get()).toEqual({
      id: "thread:s",
      room_id: "s",
      latest_sequence: 2,
    });
    expect(db.query("SELECT id, thread_id, agent_id, kind, sequence FROM session_messages WHERE session_id = 's' ORDER BY sequence").all()).toEqual([
      { id: "m2", thread_id: "thread:s", agent_id: "primary", kind: "text", sequence: 1 },
      { id: "m1", thread_id: "thread:s", agent_id: null, kind: "text", sequence: 2 },
    ]);
    expect(runMigrations(db, migrations)).toEqual([]);
  });
});
