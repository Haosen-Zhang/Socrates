import { describe, expect, it } from "bun:test";
import { openDb } from "../db";
import { ConversationMemoryStore } from "./conversation-memory-store";
import { SessionStore } from "./session-store";

describe("persisted Session tool history", () => {
  it("restores tool calls, results, and public reasoning parts in strict sequence", async () => {
    const db = openDb(":memory:");
    db.query(`
      INSERT INTO workspaces
        (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at)
      VALUES ('workspace', '/tmp/workspace', '/tmp/workspace', 'identity', 'Workspace', 'now', 'now')
    `).run();
    const sessions = new SessionStore(db);
    const session = sessions.create({
      title: "Tool history",
      mode: "single_agent",
      workspaceId: "workspace",
      primaryAgentId: "agent",
      agents: [{ agentId: "agent", snapshot: { nickname: "Agent" }, executionEligible: true }],
    });
    const memory = new ConversationMemoryStore(db);
    const thread = memory.ensureDefaultThread(session.id);
    const common = {
      roomId: session.id,
      threadId: thread.id,
      runId: "run",
      turnId: null,
      agentId: "agent",
      status: "completed",
    } as const;

    await memory.appendMessage({
      ...common,
      role: "assistant",
      kind: "tool_call",
      content: "",
      parts: [{ type: "tool_call", callId: "call", name: "read_file", input: { path: "README.md" } }],
      idempotencyKey: "call",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await memory.appendMessage({
      ...common,
      role: "tool",
      kind: "tool_result",
      content: "hello",
      parts: [{
        type: "tool_result",
        callId: "call",
        output: { preview: "hello", byteSize: 5, truncated: false },
        isError: false,
      }],
      idempotencyKey: "result",
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    await memory.appendMessage({
      ...common,
      role: "assistant",
      kind: "summary",
      content: "",
      parts: [{ type: "reasoning_summary", text: "Public summary" }],
      idempotencyKey: "summary",
      createdAt: "2026-01-01T00:00:03.000Z",
    });

    expect(sessions.listMessages(session.id).map((item) => ({
      role: item.role,
      kind: item.kind,
      sequence: item.sequence,
      parts: item.parts,
    }))).toEqual([
      {
        role: "assistant",
        kind: "tool_call",
        sequence: 1,
        parts: [{ type: "tool_call", callId: "call", name: "read_file", input: { path: "README.md" } }],
      },
      {
        role: "tool",
        kind: "tool_result",
        sequence: 2,
        parts: [{
          type: "tool_result",
          callId: "call",
          output: { preview: "hello", byteSize: 5, truncated: false },
          isError: false,
        }],
      },
      {
        role: "assistant",
        kind: "summary",
        sequence: 3,
        parts: [{ type: "reasoning_summary", text: "Public summary" }],
      },
    ]);
  });
});
