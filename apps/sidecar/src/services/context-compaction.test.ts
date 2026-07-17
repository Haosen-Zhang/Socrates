import { describe, expect, it } from "bun:test";
import { openDb } from "../db";
import { ContextCompactionService } from "./context-compaction";

describe("ContextCompactionService", () => {
  it("keeps original turns durable and reuses a traceable bounded checkpoint", () => {
    const db = openDb(":memory:");
    const now = new Date().toISOString();
    db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES ('w', '/tmp', '/tmp', 'w', 'w', ?, ?)").run(now, now);
    db.query("INSERT INTO sessions (id, title, mode, workspace_id, status, created_at, updated_at) VALUES ('s', 's', 'multi_agent', 'w', 'idle', ?, ?)").run(now, now);
    db.query("INSERT INTO multi_tasks (id, session_id, prompt, state, attempt_no, config_json, created_at, updated_at) VALUES ('t', 's', 'p', 'discussing', 1, '{}', ?, ?)").run(now, now);
    const source = Array.from({ length: 12 }, (_, index) => ({ agentId: `a${index}`, agentName: `Agent ${index}`, round: index + 1, content: "x".repeat(500) }));
    const service = new ContextCompactionService(db, 1_000);
    const first = service.compact("t", source);
    const second = service.compact("t", source);
    expect(first).toMatchObject({ compacted: true, created: true, coveredFrom: 0 });
    expect(second).toMatchObject({ compacted: true, created: false, sourceHash: first.sourceHash });
    expect(first.turns.length).toBeLessThan(source.length);
    expect(source).toHaveLength(12);
    expect(db.query("SELECT covered_to, source_hash FROM multi_compactions WHERE task_id = 't'").all()).toHaveLength(1);
  });
});
