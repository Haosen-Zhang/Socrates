import { describe, expect, it } from "bun:test";
import { openDb } from "../db";
import { ConversationMemoryStore } from "./conversation-memory-store";

function setupRooms() {
  const db = openDb(":memory:");
  const now = new Date().toISOString();
  db.query("INSERT INTO sessions (id, title, mode, kind, archived, status, created_at, updated_at) VALUES (?, ?, 'single_agent', 'cowork', 0, 'idle', ?, ?)")
    .run("room-a", "A", now, now);
  db.query("INSERT INTO sessions (id, title, mode, kind, archived, status, created_at, updated_at) VALUES (?, ?, 'single_agent', 'cowork', 0, 'idle', ?, ?)")
    .run("room-b", "B", now, now);
  return { db, memory: new ConversationMemoryStore(db) };
}

describe("ConversationMemoryStore", () => {
  it("creates an idempotent durable Turn and retries without duplicating the user message", async () => {
    const { db, memory } = setupRooms();
    const thread = memory.ensureDefaultThread("room-a");
    const first = memory.beginTurn({
      roomId: "room-a",
      threadId: thread.id,
      clientTurnKey: "client-turn",
      inputHash: "same-input",
      runId: "run-1",
      agentId: "agent",
      prompt: "remember this",
      parts: [],
    });
    expect(first.replayed).toBe(false);
    memory.updateTurnStatus(first.turnId, "failed", { completedAt: new Date().toISOString() });

    const retry = memory.beginTurn({
      roomId: "room-a",
      threadId: thread.id,
      clientTurnKey: "client-turn",
      inputHash: "same-input",
      runId: "run-2",
      agentId: "agent",
      prompt: "remember this",
      parts: [],
    });
    expect(retry.turnId).toBe(first.turnId);
    expect(retry.attemptNo).toBe(2);
    expect((await memory.listThreadMessages(thread.id)).filter((message) => message.role === "user")).toHaveLength(1);
    expect(db.query("SELECT id FROM agent_runs ORDER BY attempt_no").all()).toEqual([{ id: "run-1" }, { id: "run-2" }]);
  });

  it("replays a completed client Turn and rejects key reuse with different input", () => {
    const { memory } = setupRooms();
    const thread = memory.ensureDefaultThread("room-a");
    const first = memory.beginTurn({
      roomId: "room-a",
      threadId: thread.id,
      clientTurnKey: "completed-turn",
      inputHash: "same-input",
      runId: "run-completed",
      agentId: "agent",
      prompt: "hello",
      parts: [],
    });
    memory.updateTurnStatus(first.turnId, "completed", { completedAt: new Date().toISOString() });
    const replay = memory.beginTurn({
      roomId: "room-a",
      threadId: thread.id,
      clientTurnKey: "completed-turn",
      inputHash: "same-input",
      runId: "ignored-run",
      agentId: "agent",
      prompt: "hello",
      parts: [],
    });
    expect(replay).toMatchObject({ replayed: true, runId: "run-completed", status: "completed" });
    expect(() => memory.beginTurn({
      roomId: "room-a",
      threadId: thread.id,
      clientTurnKey: "completed-turn",
      inputHash: "different-input",
      runId: "conflict-run",
      agentId: "agent",
      prompt: "changed",
      parts: [],
    })).toThrow("client_turn_key_conflict");
  });

  it("stores locally with strict per-Thread sequence and idempotent append", async () => {
    const { memory } = setupRooms();
    const thread = memory.ensureDefaultThread("room-a");
    const first = await memory.appendMessage({
      roomId: "room-a", threadId: thread.id, runId: "run-1", turnId: "turn-1", agentId: null,
      role: "user", kind: "text", content: "hello", status: "completed", idempotencyKey: "user:turn-1",
      parts: [{ type: "text", text: "hello" }],
    });
    const replay = await memory.appendMessage({
      roomId: "room-a", threadId: thread.id, runId: "run-1", turnId: "turn-1", agentId: null,
      role: "user", kind: "text", content: "hello", status: "completed", idempotencyKey: "user:turn-1",
      parts: [{ type: "text", text: "hello" }],
    });
    const assistant = await memory.appendMessage({
      roomId: "room-a", threadId: thread.id, runId: "run-1", turnId: "turn-1", agentId: "agent",
      role: "assistant", kind: "text", content: "world", status: "completed", idempotencyKey: "assistant:turn-1",
      parts: [{ type: "text", text: "world" }],
    });

    expect(replay.messageId).toBe(first.messageId);
    expect([first.sequence, assistant.sequence]).toEqual([1, 2]);
    expect(await memory.getLatestSequence(thread.id)).toBe(2);
    expect((await memory.listThreadMessages(thread.id)).map((message) => message.content)).toEqual(["hello", "world"]);
  });

  it("isolates Rooms and independent Threads", async () => {
    const { memory } = setupRooms();
    const a = memory.ensureDefaultThread("room-a");
    const b = memory.ensureDefaultThread("room-b");
    const alternate = memory.createThread("room-a");
    await memory.appendMessage({
      roomId: "room-a", threadId: a.id, runId: null, turnId: null, agentId: null,
      role: "user", kind: "text", content: "a", status: "completed", idempotencyKey: "a",
      parts: [{ type: "text", text: "a" }],
    });
    await memory.appendMessage({
      roomId: "room-b", threadId: b.id, runId: null, turnId: null, agentId: null,
      role: "user", kind: "text", content: "b", status: "completed", idempotencyKey: "b",
      parts: [{ type: "text", text: "b" }],
    });
    await memory.appendMessage({
      roomId: "room-a", threadId: alternate.id, runId: null, turnId: null, agentId: null,
      role: "user", kind: "text", content: "alternate", status: "completed", idempotencyKey: "alternate",
      parts: [{ type: "text", text: "alternate" }],
    });

    expect((await memory.listThreadMessages(a.id)).map((item) => item.content)).toEqual(["a"]);
    expect((await memory.listThreadMessages(b.id)).map((item) => item.content)).toEqual(["b"]);
    expect((await memory.listThreadMessages(alternate.id)).map((item) => item.content)).toEqual(["alternate"]);
  });

  it("round-trips structured tool calls and results", async () => {
    const { memory } = setupRooms();
    const thread = memory.ensureDefaultThread("room-a");
    await memory.appendMessage({
      roomId: "room-a", threadId: thread.id, runId: "run", turnId: "turn", agentId: "agent",
      role: "assistant", kind: "tool_call", content: "", status: "completed", idempotencyKey: "tool-call:turn:call",
      parts: [{ type: "tool_call", callId: "call", name: "read_file", input: { path: "a.txt" } }],
    });
    await memory.appendMessage({
      roomId: "room-a", threadId: thread.id, runId: "run", turnId: "turn", agentId: "agent",
      role: "tool", kind: "tool_result", content: "", status: "completed", idempotencyKey: "tool-result:turn:call",
      parts: [{ type: "tool_result", callId: "call", output: { preview: "ok", byteSize: 2, truncated: false }, isError: false }],
    });

    expect((await memory.listThreadMessages(thread.id)).map((item) => item.parts[0])).toEqual([
      { type: "tool_call", callId: "call", name: "read_file", input: { path: "a.txt" } },
      { type: "tool_result", callId: "call", output: { preview: "ok", byteSize: 2, truncated: false }, isError: false },
    ]);
  });
});
