import { describe, expect, it } from "bun:test";
import { openDb } from "../db";
import { SessionStore } from "./session-store";

describe("SessionStore", () => {
  it("creates all three modes with immutable agent snapshots", () => {
    const store = new SessionStore(openDb(":memory:"));
    expect(store.create({ title: "Chat", mode: "chat", agents: [] }).mode).toBe("chat");
    expect(store.create({ title: "Solo", mode: "single_agent", agents: [{ agentId: "a", snapshot: { nickname: "A" }, executionEligible: true }] }).mode).toBe("single_agent");
    const multi = store.create({
      title: "Team",
      mode: "multi_agent",
      agents: [
        { agentId: "a", snapshot: { nickname: "A" }, executionEligible: true },
        { agentId: "b", snapshot: { nickname: "B" }, executionEligible: false },
      ],
    });
    expect(multi.agents.map((agent) => agent.snapshot)).toEqual([{ nickname: "A" }, { nickname: "B" }]);
  });

  it("rejects invalid cardinality and duplicate agents", () => {
    const store = new SessionStore(openDb(":memory:"));
    expect(() => store.create({ title: "Bad", mode: "single_agent", agents: [] })).toThrow("single_agent_requires_one_agent");
    expect(() => store.create({ title: "Bad", mode: "multi_agent", agents: [
      { agentId: "a", snapshot: {}, executionEligible: false },
      { agentId: "a", snapshot: {}, executionEligible: false },
    ] })).toThrow("duplicate_session_agent");
  });

  it("binds a workspace only while the session is inactive", () => {
    const db = openDb(":memory:");
    const store = new SessionStore(db);
    const session = store.create({ title: "Chat", mode: "chat", agents: [] });
    db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("w", "/tmp/w", "/tmp/w", "hash", "w", "now", "now");
    expect(store.bindWorkspace(session.id, "w").workspaceId).toBe("w");
    db.query("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);
    expect(() => store.bindWorkspace(session.id, null)).toThrow("active_session_workspace_locked");
  });

  it("renames and archives an inactive conversation", () => {
    const store = new SessionStore(openDb(":memory:"));
    const session = store.create({ title: "Before", mode: "chat", agents: [] });
    expect(store.rename(session.id, "After").title).toBe("After");
    expect(store.archive(session.id, true).archived).toBe(true);
    expect(store.list().map((item) => item.id)).toEqual([session.id]);
  });

  it("rewinds persisted context but never relies on reversing external workspace effects", () => {
    const db = openDb(":memory:");
    const store = new SessionStore(db);
    const session = store.create({ title: "Chat", mode: "chat", agents: [] });
    const insert = db.query("INSERT INTO session_messages (id, session_id, role, author_id, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    insert.run("first", session.id, "user", null, "first turn", "completed", "2026-01-01T00:00:00.000Z");
    insert.run("second", session.id, "assistant", null, "later turn", "completed", "2026-01-01T00:00:01.000Z");

    store.rewind(session.id, "second");
    expect(store.listMessages(session.id).map((message) => message.id)).toEqual(["first"]);
    expect(store.get(session.id)?.status).toBe("idle");
  });

  it("removes local conversation records only when the session is inactive", () => {
    const db = openDb(":memory:");
    const store = new SessionStore(db);
    const session = store.create({ title: "Disposable", mode: "chat", agents: [] });
    store.remove(session.id);
    expect(store.get(session.id)).toBeNull();
  });
});
