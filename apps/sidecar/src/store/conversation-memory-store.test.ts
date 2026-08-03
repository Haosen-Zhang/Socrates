import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db";
import { ConversationMemoryStore } from "./conversation-memory-store";
import { HistoryStore } from "./history-store";

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
  it("persists complete Turns through the local HistoryStore authority", async () => {
    const { db } = setupRooms();
    const dir = mkdtempSync(join(tmpdir(), "socrates-memory-history-"));
    try {
      const history = new HistoryStore(db, dir);
      const memory = new ConversationMemoryStore(db, history);
      const thread = memory.ensureDefaultThread("room-a");
      const turn = await memory.beginTurn({
        roomId: "room-a", threadId: thread.id, clientTurnKey: "durable-turn", inputHash: "input",
        runId: "run", agentId: "agent", prompt: "hello", parts: [],
      });
      await memory.completeTurn({
        roomId: "room-a", runId: "run", turnId: turn.turnId, completedAt: new Date().toISOString(),
        assistantMessage: {
          messageId: "assistant", roomId: "room-a", threadId: thread.id, runId: "run", turnId: turn.turnId,
          agentId: "agent", role: "assistant", kind: "text", content: "world",
          parts: [{ type: "text", text: "world" }], status: "completed", idempotencyKey: "assistant:durable-turn",
        },
      });

      expect(readFileSync(history.roomPath("room-a"), "utf8").trim().split("\n")).toHaveLength(2);
      expect((await memory.listThreadMessages(thread.id)).map((message) => message.content)).toEqual(["hello", "world"]);

      db.query("DELETE FROM message_parts WHERE message_id IN (SELECT id FROM session_messages WHERE session_id = 'room-a')").run();
      db.query("DELETE FROM session_messages WHERE session_id = 'room-a'").run();
      await new HistoryStore(db, dir).bootstrapSession("room-a");
      expect((await memory.listThreadMessages(thread.id)).map((message) => message.content)).toEqual(["hello", "world"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("retries the same durable user record after its Turn projection rolls back", async () => {
    const { db } = setupRooms();
    const dir = mkdtempSync(join(tmpdir(), "socrates-memory-retry-"));
    try {
      const history = new HistoryStore(db, dir);
      const memory = new ConversationMemoryStore(db, history);
      const thread = memory.ensureDefaultThread("room-a");
      const input = {
        roomId: "room-a", threadId: thread.id, clientTurnKey: "projection-retry", inputHash: "same",
        runId: "run", agentId: "agent", prompt: "persist once", parts: [],
      };
      db.exec(`CREATE TRIGGER fail_turn_projection BEFORE INSERT ON conversation_turns
        BEGIN SELECT RAISE(ABORT, 'injected_turn_projection_failure'); END`);
      await expect(memory.beginTurn(input)).rejects.toThrow("injected_turn_projection_failure");
      expect(readFileSync(history.roomPath("room-a"), "utf8").trim().split("\n")).toHaveLength(1);
      expect(db.query("SELECT id FROM session_messages WHERE session_id = 'room-a'").get()).toBeNull();

      db.exec("DROP TRIGGER fail_turn_projection");
      const retry = await memory.beginTurn(input);
      expect(retry.replayed).toBe(false);
      expect((await memory.listThreadMessages(thread.id)).map((message) => message.content)).toEqual(["persist once"]);
      expect(readFileSync(history.roomPath("room-a"), "utf8").trim().split("\n")).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("replays a durable Turn projection after a sidecar restart", async () => {
    const { db } = setupRooms();
    const dir = mkdtempSync(join(tmpdir(), "socrates-memory-restart-"));
    try {
      const history = new HistoryStore(db, dir);
      const memory = new ConversationMemoryStore(db, history);
      const thread = memory.ensureDefaultThread("room-a");
      db.exec(`CREATE TRIGGER fail_turn_projection BEFORE INSERT ON conversation_turns
        BEGIN SELECT RAISE(ABORT, 'injected_turn_projection_failure'); END`);
      await expect(memory.beginTurn({
        roomId: "room-a", threadId: thread.id, clientTurnKey: "restart", inputHash: "same",
        runId: "restart-run", agentId: "agent", prompt: "survive restart", parts: [],
      })).rejects.toThrow("injected_turn_projection_failure");
      db.exec("DROP TRIGGER fail_turn_projection");

      const restartedHistory = new HistoryStore(db, dir);
      const restartedMemory = new ConversationMemoryStore(db, restartedHistory);
      await restartedHistory.bootstrapSession("room-a");
      expect(db.query("SELECT id FROM conversation_turns").all()).toHaveLength(1);
      expect(db.query("SELECT id FROM agent_runs").all()).toEqual([{ id: "restart-run" }]);
      expect((await restartedMemory.listThreadMessages(thread.id)).map((message) => message.content))
        .toEqual(["survive restart"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("creates an idempotent durable Turn and retries without duplicating the user message", async () => {
    const { db, memory } = setupRooms();
    const thread = memory.ensureDefaultThread("room-a");
    const first = await memory.beginTurn({
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

    const retry = await memory.beginTurn({
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

  it("replays a completed client Turn and rejects key reuse with different input", async () => {
    const { memory } = setupRooms();
    const thread = memory.ensureDefaultThread("room-a");
    const first = await memory.beginTurn({
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
    const replay = await memory.beginTurn({
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
    await expect(memory.beginTurn({
      roomId: "room-a",
      threadId: thread.id,
      clientTurnKey: "completed-turn",
      inputHash: "different-input",
      runId: "conflict-run",
      agentId: "agent",
      prompt: "changed",
      parts: [],
    })).rejects.toThrow("client_turn_key_conflict");
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

  it("returns the newest bounded history and rejects conflicting idempotency payloads", async () => {
    const { memory } = setupRooms();
    const thread = memory.ensureDefaultThread("room-a");
    for (let index = 1; index <= 5; index += 1) {
      await memory.appendMessage({
        roomId: "room-a",
        threadId: thread.id,
        runId: `run-${index}`,
        turnId: `turn-${index}`,
        agentId: null,
        role: "user",
        kind: "text",
        content: `message-${index}`,
        status: "completed",
        idempotencyKey: `message-${index}`,
        parts: [{ type: "text", text: `message-${index}` }],
      });
    }
    expect((await memory.listThreadMessages(thread.id, { limit: 3 })).map((message) => message.sequence))
      .toEqual([3, 4, 5]);
    expect((await memory.listThreadMessages(thread.id, { afterSequence: 2, limit: 2 })).map((message) => message.sequence))
      .toEqual([3, 4]);
    await expect(memory.appendMessage({
      roomId: "room-a",
      threadId: thread.id,
      runId: "other-run",
      turnId: "turn-5",
      agentId: null,
      role: "user",
      kind: "text",
      content: "different",
      status: "completed",
      idempotencyKey: "message-5",
      parts: [{ type: "text", text: "different" }],
    })).rejects.toThrow("message_idempotency_conflict");
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
