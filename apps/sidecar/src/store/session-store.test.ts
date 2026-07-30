import { describe, expect, it } from "bun:test";
import { openDb } from "../db";
import { SessionStore } from "./session-store";
import { ConversationMemoryStore } from "./conversation-memory-store";
import { ApprovalManager } from "../approvals/manager";
import { DEFAULT_COLLABORATION_SETTINGS } from "@socrates/core";

describe("SessionStore", () => {
  it("copies and resolves global collaboration defaults when creating a room", () => {
    const db = openDb(":memory:");
    db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES ('w', '/tmp/w', '/tmp/w', 'hash', 'w', 'now', 'now')").run();
    const store = new SessionStore(db);
    const session = store.create({
      title: "Defaults",
      mode: "multi_agent",
      workspaceId: "w",
      primaryAgentId: "b",
      collaborationDefaults: {
        ...DEFAULT_COLLABORATION_SETTINGS,
        strategy: "team",
        discussion: {
          ...DEFAULT_COLLABORATION_SETTINGS.discussion,
          enabled: true,
        },
      },
      agents: [
        { agentId: "a", snapshot: {}, executionEligible: true },
        { agentId: "b", snapshot: {}, executionEligible: true },
      ],
    });

    expect(session.collaboration.strategy).toBe("team");
    expect(session.collaboration.assignment.coordinatorAgentId).toBe("b");
    expect(session.collaboration.discussion.speakerOrder).toEqual(["a", "b"]);
    expect(session.collaboration.discussion.summaryAgentId).toBe("b");
  });

  it("safely reassigns collaboration roles when a member is removed", () => {
    const db = openDb(":memory:");
    db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES ('w', '/tmp/w', '/tmp/w', 'hash', 'w', 'now', 'now')").run();
    const store = new SessionStore(db);
    const session = store.create({
      title: "Roles",
      mode: "multi_agent",
      workspaceId: "w",
      primaryAgentId: "a",
      agents: [
        { agentId: "a", snapshot: {}, executionEligible: true },
        { agentId: "b", snapshot: {}, executionEligible: true },
        { agentId: "c", snapshot: {}, executionEligible: true },
      ],
    });
    store.updateCollaboration(session.id, {
      ...DEFAULT_COLLABORATION_SETTINGS,
      strategy: "team",
      assignment: {
        ...DEFAULT_COLLABORATION_SETTINGS.assignment,
        coordinatorAgentId: "b",
        callableAgentIds: ["b", "c"],
      },
      discussion: {
        ...DEFAULT_COLLABORATION_SETTINGS.discussion,
        enabled: true,
        speakerOrder: ["b", "c"],
        summaryAgentId: "b",
      },
      planConfirmation: { mode: "reviewer", reviewerAgentId: "b" },
    });

    const updated = store.removeAgent(session.id, "b");
    expect(updated.collaboration.assignment.coordinatorAgentId).toBe("a");
    expect(updated.collaboration.discussion.speakerOrder).toEqual(["c"]);
    expect(updated.collaboration.discussion.summaryAgentId).toBe("a");
    expect(updated.collaboration.planConfirmation).toEqual({
      mode: "reviewer",
      reviewerAgentId: "a",
    });
  });

  it("persists an explicit primary Agent independently of member position", () => {
    const db = openDb(":memory:");
    db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES ('w', '/tmp/w', '/tmp/w', 'hash', 'w', 'now', 'now')").run();
    const store = new SessionStore(db);
    const session = store.create({
      title: "Explicit primary",
      mode: "multi_agent",
      workspaceId: "w",
      primaryAgentId: "second",
      agents: [
        { agentId: "first", snapshot: {}, executionEligible: true },
        { agentId: "second", snapshot: {}, executionEligible: true },
      ],
    });
    expect(session.primaryAgentId).toBe("second");
    expect(store.get(session.id)?.primaryAgentId).toBe("second");
  });

  it("locks collaboration settings while a room is running", () => {
    const db = openDb(":memory:");
    db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES ('w', '/tmp/w', '/tmp/w', 'hash', 'w', 'now', 'now')").run();
    const store = new SessionStore(db);
    const session = store.create({
      title: "Running",
      mode: "single_agent",
      workspaceId: "w",
      primaryAgentId: "a",
      agents: [{ agentId: "a", snapshot: {}, executionEligible: true }],
    });
    db.query("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);

    expect(() => store.updateCollaboration(
      session.id,
      DEFAULT_COLLABORATION_SETTINGS,
    )).toThrow("active_session_collaboration_locked");
    expect(() => store.restoreCollaborationDefaults(
      session.id,
      DEFAULT_COLLABORATION_SETTINGS,
    )).toThrow("active_session_collaboration_locked");
  });

  it("adds and removes co-work members and recomputes mode by member count", () => {
    const db = openDb(":memory:");
    const store = new SessionStore(db);
    db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES ('w','/w','/w','h','w','now','now')").run();
    const session = store.create({ title: "Cowork", mode: "single_agent", workspaceId: "w", primaryAgentId: "a", agents: [{ agentId: "a", snapshot: { nickname: "A" }, executionEligible: true }] });
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
    const session = store.create({ title: "Cowork", mode: "single_agent", workspaceId: "w", primaryAgentId: "a", agents: [{ agentId: "a", snapshot: {}, executionEligible: true }] });
    db.query("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);
    expect(() => store.addAgent(session.id, "b", {})).toThrow("active_session_members_locked");
  });

  it("creates all three modes with immutable agent snapshots", () => {
    const db = openDb(":memory:");
    const store = new SessionStore(db);
    db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("w1", "/tmp/w1", "/tmp/w1", "hash1", "w1", "now", "now");
    expect(store.create({ title: "Chat", mode: "chat", primaryAgentId: "a", agents: [{ agentId: "a", snapshot: { nickname: "A" }, executionEligible: false }] }).mode).toBe("chat");
    expect(store.create({ title: "Solo", mode: "single_agent", workspaceId: "w1", primaryAgentId: "a", agents: [{ agentId: "a", snapshot: { nickname: "A" }, executionEligible: true }] }).mode).toBe("single_agent");
    const multi = store.create({
      title: "Team",
      mode: "multi_agent",
      workspaceId: "w1",
      primaryAgentId: "a",
      agents: [
        { agentId: "a", snapshot: { nickname: "A" }, executionEligible: true },
        { agentId: "b", snapshot: { nickname: "B" }, executionEligible: false },
      ],
    });
    expect(multi.agents.map((agent) => agent.snapshot)).toEqual([{ nickname: "A" }, { nickname: "B" }]);
    expect(() => store.create({
      title: "Missing primary",
      mode: "multi_agent",
      workspaceId: "w1",
      primaryAgentId: "missing",
      agents: [
        { agentId: "a", snapshot: {}, executionEligible: true },
        { agentId: "b", snapshot: {}, executionEligible: true },
      ],
    })).toThrow("primary_agent_must_be_room_member");
  });

  it("rejects invalid cardinality and duplicate agents", () => {
    const store = new SessionStore(openDb(":memory:"));
    expect(() => store.create({ title: "Bad", mode: "single_agent", primaryAgentId: "a", agents: [] })).toThrow("single_agent_requires_one_agent");
    expect(() => store.create({ title: "Bad", mode: "multi_agent", primaryAgentId: "a", agents: [
      { agentId: "a", snapshot: {}, executionEligible: false },
      { agentId: "a", snapshot: {}, executionEligible: false },
    ] })).toThrow("duplicate_session_agent");
  });

  it("refuses to bind a co-work room to an archived workspace", () => {
    const db = openDb(":memory:");
    const store = new SessionStore(db);
    db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, archived, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)")
      .run("wa", "/tmp/wa", "/tmp/wa", "hasha", "wa", "now", "now");
    expect(() => store.create({ title: "Cowork", mode: "single_agent", workspaceId: "wa", primaryAgentId: "a", agents: [{ agentId: "a", snapshot: { nickname: "A" }, executionEligible: true }] }))
      .toThrow("workspace_archived");
  });

  it("binds a workspace only while the session is inactive", () => {
    const db = openDb(":memory:");
    const store = new SessionStore(db);
    const session = store.create({ title: "Chat", mode: "chat", primaryAgentId: "a", agents: [{ agentId: "a", snapshot: { nickname: "A" }, executionEligible: false }] });
    db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("w", "/tmp/w", "/tmp/w", "hash", "w", "now", "now");
    expect(store.bindWorkspace(session.id, "w").workspaceId).toBe("w");
    db.query("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);
    expect(() => store.bindWorkspace(session.id, null)).toThrow("active_session_workspace_locked");
  });

  it("renames and archives an inactive conversation", () => {
    const store = new SessionStore(openDb(":memory:"));
    const session = store.create({ title: "Before", mode: "chat", primaryAgentId: "a", agents: [{ agentId: "a", snapshot: { nickname: "A" }, executionEligible: false }] });
    expect(store.rename(session.id, "After").title).toBe("After");
    expect(store.archive(session.id, true).archived).toBe(true);
    expect(store.list().map((item) => item.id)).toEqual([session.id]);
  });

  it("persists room-scoped approval policy and increments its evidence version", () => {
    const db = openDb(":memory:");
    const store = new SessionStore(db);
    const first = store.create({
      title: "Policy",
      mode: "chat",
      primaryAgentId: "a",
      agents: [{ agentId: "a", snapshot: {}, executionEligible: false }],
    });
    const other = store.create({
      title: "Other",
      mode: "chat",
      primaryAgentId: "a",
      agents: [{ agentId: "a", snapshot: {}, executionEligible: false }],
    });
    expect(first.approvalPolicy).toEqual({ mode: "ask", version: 1 });

    const changed = store.updateApprovalPolicy(first.id, "workspace_full");
    expect(changed.approvalPolicy).toEqual({ mode: "workspace_full", version: 2 });
    expect(store.get(other.id)?.approvalPolicy).toEqual({ mode: "ask", version: 1 });
    expect(store.updateApprovalPolicy(first.id, "workspace_full").approvalPolicy.version).toBe(2);
  });

  it("does not retroactively resolve pending approvals when the room policy changes", () => {
    const db = openDb(":memory:");
    const store = new SessionStore(db);
    const session = store.create({
      title: "Pending",
      mode: "chat",
      primaryAgentId: "a",
      agents: [{ agentId: "a", snapshot: {}, executionEligible: false }],
    });
    const approvals = new ApprovalManager(db);
    const request = approvals.request({
      taskId: "task",
      kind: "tool",
      subjectId: "subject",
      inputHash: "input",
      workspaceIdentity: "workspace",
      attemptId: "attempt",
      policyVersion: session.approvalPolicy.version,
      risk: "high",
      freshHumanRequired: true,
    });

    store.updateApprovalPolicy(session.id, "workspace_full");

    expect(approvals.getRequest(request.id)).toMatchObject({
      status: "pending",
      policyVersion: 1,
    });
    expect(store.get(session.id)?.approvalPolicy.version).toBe(2);
  });

  it("rewinds persisted context but never relies on reversing external workspace effects", () => {
    const db = openDb(":memory:");
    const store = new SessionStore(db);
    const session = store.create({ title: "Chat", mode: "chat", primaryAgentId: "a", agents: [{ agentId: "a", snapshot: { nickname: "A" }, executionEligible: false }] });
    const insert = db.query("INSERT INTO session_messages (id, session_id, role, author_id, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    insert.run("first", session.id, "user", null, "first turn", "completed", "2026-01-01T00:00:00.000Z");
    insert.run("second", session.id, "assistant", null, "later turn", "completed", "2026-01-01T00:00:01.000Z");

    store.rewind(session.id, "second");
    expect(store.listMessages(session.id).map((message) => message.id)).toEqual(["first"]);
    expect(store.get(session.id)?.status).toBe("idle");
  });

  it("rewinds sequenced local memory and allows the next append to reuse the released sequence", async () => {
    const db = openDb(":memory:");
    const store = new SessionStore(db);
    db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES ('w','/w','/w','h','w','now','now')").run();
    const session = store.create({
      title: "Memory",
      mode: "single_agent",
      workspaceId: "w",
      primaryAgentId: "a",
      agents: [{ agentId: "a", snapshot: {}, executionEligible: true }],
    });
    const memory = new ConversationMemoryStore(db);
    const thread = memory.ensureDefaultThread(session.id);
    const user = await memory.appendMessage({
      roomId: session.id,
      threadId: thread.id,
      runId: "run",
      turnId: "turn",
      agentId: null,
      role: "user",
      kind: "text",
      content: "question",
      parts: [{ type: "text", text: "question" }],
      status: "completed",
      idempotencyKey: "user",
    });
    const answer = await memory.appendMessage({
      roomId: session.id,
      threadId: thread.id,
      runId: "run",
      turnId: "turn",
      agentId: "a",
      role: "assistant",
      kind: "text",
      content: "answer",
      parts: [{ type: "text", text: "answer" }],
      status: "completed",
      idempotencyKey: "answer",
    });
    store.rewind(session.id, answer.messageId);
    const replacement = await memory.appendMessage({
      roomId: session.id,
      threadId: thread.id,
      runId: "replacement-run",
      turnId: "replacement-turn",
      agentId: "a",
      role: "assistant",
      kind: "text",
      content: "replacement",
      parts: [{ type: "text", text: "replacement" }],
      status: "completed",
      idempotencyKey: "replacement",
    });
    expect(user.sequence).toBe(1);
    expect(replacement.sequence).toBe(2);
    expect((await memory.listThreadMessages(thread.id)).map((message) => message.content))
      .toEqual(["question", "replacement"]);
  });

  it("removes local conversation records only when the session is inactive", () => {
    const db = openDb(":memory:");
    const store = new SessionStore(db);
    const session = store.create({ title: "Disposable", mode: "chat", primaryAgentId: "a", agents: [{ agentId: "a", snapshot: { nickname: "A" }, executionEligible: false }] });
    store.remove(session.id);
    expect(store.get(session.id)).toBeNull();
  });
});
