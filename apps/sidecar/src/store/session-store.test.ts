import { describe, expect, it } from "bun:test";
import { openDb } from "../db";
import { SessionStore } from "./session-store";

describe("SessionStore", () => {
  it("adds and removes co-work members and recomputes mode by member count", () => {
    const db = openDb(":memory:");
    const store = new SessionStore(db);
    db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES ('w','/w','/w','h','w','now','now')").run();
    const session = store.create({ title: "Cowork", mode: "single_agent", workspaceId: "w", agents: [{ agentId: "a", snapshot: { nickname: "A" }, executionEligible: true }] });
    expect(session.mode).toBe("single_agent");

    // 加第二人 → multi_agent
    const two = store.addAgent(session.id, "b", { nickname: "B" });
    expect(two.agents.map((m) => m.agentId)).toEqual(["a", "b"]);
    expect(two.mode).toBe("multi_agent");

    // 踢回一人 → single_agent，position 重排连续
    const one = store.removeAgent(session.id, "a");
    expect(one.agents.map((m) => m.agentId)).toEqual(["b"]);
    expect(one.agents[0]!.position).toBe(0);
    expect(one.mode).toBe("single_agent");

    // 不能踢到 0 人，不能重复加
    expect(() => store.removeAgent(session.id, "b")).toThrow("session_requires_at_least_one_member");
    expect(() => store.addAgent(session.id, "b", { nickname: "B" })).toThrow("session_agent_already_member");
  });

  it("locks member changes while the session is running", () => {
    const db = openDb(":memory:");
    const store = new SessionStore(db);
    db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES ('w','/w','/w','h','w','now','now')").run();
    const session = store.create({ title: "Cowork", mode: "single_agent", workspaceId: "w", agents: [{ agentId: "a", snapshot: {}, executionEligible: true }] });
    db.query("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);
    expect(() => store.addAgent(session.id, "b", {})).toThrow("active_session_members_locked");
  });

  it("creates all three modes with immutable agent snapshots", () => {
    const db = openDb(":memory:");
    const store = new SessionStore(db);
    db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("w1", "/tmp/w1", "/tmp/w1", "hash1", "w1", "now", "now");
    expect(store.create({ title: "Chat", mode: "chat", agents: [{ agentId: "a", snapshot: { nickname: "A" }, executionEligible: false }] }).mode).toBe("chat");
    expect(store.create({ title: "Solo", mode: "single_agent", workspaceId: "w1", agents: [{ agentId: "a", snapshot: { nickname: "A" }, executionEligible: true }] }).mode).toBe("single_agent");
    const multi = store.create({
      title: "Team",
      mode: "multi_agent",
      workspaceId: "w1",
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

  it("refuses to bind a co-work room to an archived workspace", () => {
    const db = openDb(":memory:");
    const store = new SessionStore(db);
    db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, archived, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)")
      .run("wa", "/tmp/wa", "/tmp/wa", "hasha", "wa", "now", "now");
    expect(() => store.create({ title: "Cowork", mode: "single_agent", workspaceId: "wa", agents: [{ agentId: "a", snapshot: { nickname: "A" }, executionEligible: true }] }))
      .toThrow("workspace_archived");
  });

  it("binds a workspace only while the session is inactive", () => {
    const db = openDb(":memory:");
    const store = new SessionStore(db);
    const session = store.create({ title: "Chat", mode: "chat", agents: [{ agentId: "a", snapshot: { nickname: "A" }, executionEligible: false }] });
    db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("w", "/tmp/w", "/tmp/w", "hash", "w", "now", "now");
    expect(store.bindWorkspace(session.id, "w").workspaceId).toBe("w");
    db.query("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);
    expect(() => store.bindWorkspace(session.id, null)).toThrow("active_session_workspace_locked");
  });

  it("renames and archives an inactive conversation", () => {
    const store = new SessionStore(openDb(":memory:"));
    const session = store.create({ title: "Before", mode: "chat", agents: [{ agentId: "a", snapshot: { nickname: "A" }, executionEligible: false }] });
    expect(store.rename(session.id, "After").title).toBe("After");
    expect(store.archive(session.id, true).archived).toBe(true);
    expect(store.list().map((item) => item.id)).toEqual([session.id]);
  });

  it("rewinds persisted context but never relies on reversing external workspace effects", () => {
    const db = openDb(":memory:");
    const store = new SessionStore(db);
    const session = store.create({ title: "Chat", mode: "chat", agents: [{ agentId: "a", snapshot: { nickname: "A" }, executionEligible: false }] });
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
    const session = store.create({ title: "Disposable", mode: "chat", agents: [{ agentId: "a", snapshot: { nickname: "A" }, executionEligible: false }] });
    store.remove(session.id);
    expect(store.get(session.id)).toBeNull();
  });
});
