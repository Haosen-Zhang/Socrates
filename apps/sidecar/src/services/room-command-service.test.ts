import { expect, test } from "bun:test";
import { openDb } from "../db";
import { SessionStore } from "../store/session-store";
import { ConversationMemoryStore } from "../store/conversation-memory-store";
import { RoomCommandService } from "./room-command-service";
import type { ModelGateway } from "@socrates/core";

function fixture(gateway?: ModelGateway) {
  const db = openDb(":memory:");
  const sessions = new SessionStore(db);
  const room = sessions.create({ title: "Chat", mode: "chat", primaryAgentId: "a", agents: ["a", "b"].map((agentId) => ({ agentId, snapshot: { nickname: agentId, providerId: "p", modelId: "m" }, executionEligible: true })) });
  let calls = 0;
  const service = new RoomCommandService(db, sessions, {
    startDirect: async () => { calls++; await Promise.resolve(); return { runId: `run-${calls}` }; },
    getDirect: () => null,
    createTeam: async () => ({ taskId: "team" }),
    resolveAgent: (id, snapshot) => ({ id, nickname: String(snapshot.nickname), modelId: "m", role: "", systemPrompt: "", providerType: "openai_compatible", baseUrl: "", apiKey: "test" }),
    gateway: gateway ?? (async function* () { yield { type: "delta", text: "answer" }; yield { type: "done" }; }),
  });
  return { db, sessions, room, service, calls: () => calls };
}
test("concurrent duplicate commands dispatch once; request content conflicts are rejected", async () => {
  const f = fixture();
  const input = { roomId: f.room.id, clientRequestId: "request", content: "quoted @b", mentions: [], intent: "respond" as const };
  const [a,b] = await Promise.all([f.service.submit(input), f.service.submit(input)]);
  expect(a.runId).toBe(b.runId);
  expect(f.calls()).toBe(1);
  await expect(f.service.submit({ ...input, content: "changed" })).rejects.toThrow("client_request_conflict");
  f.db.close();
});
test("discussion stores user once, actual authors, fixed history and persisted replay events", async () => {
  const requests: unknown[] = [];
  const f = fixture(async function* (input) { requests.push(input.messages); yield { type: "delta", text: `answer${requests.length}` }; yield { type: "done" }; });
  const input = { roomId: f.room.id, clientRequestId: "discussion", content: "question", mentions: [{ type: "all" as const }], intent: "respond" as const };
  const cmd = await f.service.submit(input);
  await f.service.wait(cmd.commandId);
  const messages = f.sessions.listMessages(f.room.id);
  expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
  expect(messages.filter((m) => m.role === "assistant").map((m) => m.authorId)).toEqual(["a", "b"]);
  expect(f.service.get(cmd.commandId)?.status).toBe("completed");
  expect(f.service.eventsAfter(cmd.commandId, 0).at(-1)?.type).toBe("completed");
  expect(f.calls()).toBe(0);
  const replay = await f.service.submit(input);
  expect(replay.commandId).toBe(cmd.commandId);
  expect(f.sessions.listMessages(f.room.id)).toHaveLength(3);
  f.db.close();
});
test("invalid membership and Chat execution rejected before dispatch", async () => {
  const f = fixture();
  const input = { roomId: f.room.id, clientRequestId: "invalid", content: "question", mentions: [{ type: "agent" as const, agentId: "outside" }], intent: "respond" as const };
  await expect(f.service.submit(input)).rejects.toThrow("mention_must_be_room_member");
  await expect(f.service.submit({ ...input, mentions: [], intent: "execute" })).rejects.toThrow("chat_execution_forbidden");
  expect(f.calls()).toBe(0);
  f.db.close();
});
test("different request IDs cannot race the same idle room while dispatch is awaiting", async () => {
  const f = fixture();
  const input = { roomId: f.room.id, clientRequestId: "first", content: "question", mentions: [], intent: "respond" as const };
  const first = f.service.submit(input);
  await expect(f.service.submit({ ...input, clientRequestId: "second" })).rejects.toThrow("room_command_already_running");
  await first;
  expect(f.calls()).toBe(1);
  f.db.close();
});
test("discussion respects configured order and bounded rounds with selected summary author", async () => {
  const f = fixture();
  f.sessions.updateCollaboration(f.room.id, { ...f.room.collaboration, discussion: { enabled: true, mode: "round_robin", maxRounds: 1, speakerOrder: ["b", "a"], summaryAgentId: "b" } });
  const command = await f.service.submit({ roomId: f.room.id, clientRequestId: "ordered", content: "discuss", mentions: [{ type: "all" }], intent: "respond" });
  await f.service.wait(command.commandId);
  const replies = f.sessions.listMessages(f.room.id).filter((m) => m.role === "assistant");
  expect(replies.map((m) => m.authorId)).toEqual(["b", "a", "b"]);
  expect(replies.every((m) => m.runId === command.commandId)).toBe(true);
  f.sessions.updateAgentSnapshot(f.room.id, "b", { modelId: "changed" });
  expect(f.sessions.listMessages(f.room.id).filter((m) => m.role === "assistant")[0]?.authorSnapshot?.modelId).toBe("m");
  expect(f.service.eventsAfter(command.commandId, 0).find((e) => e.type === "participants_resolved")?.profiles).toBeDefined();
  f.db.close();
});
test("restart rebinds a child persisted before command linkage and follows continuation attempts", async () => {
  const f = fixture();
  const command = await f.service.submit({ roomId: f.room.id, clientRequestId: "rebind", content: "question", mentions: [], intent: "respond" });
  const memory = new ConversationMemoryStore(f.db);
  const thread = memory.ensureDefaultThread(f.room.id);
  const turn = await memory.beginTurn({ roomId: f.room.id, threadId: thread.id, clientTurnKey: `room-command:${command.commandId}`, inputHash: "same-input", runId: "durable-child", agentId: "a", prompt: "question", parts: [] });
  f.db.run("UPDATE room_commands SET status='dispatching',run_id=NULL WHERE id=?", [command.commandId]);
  f.service.recoverInterrupted();
  expect(f.service.get(command.commandId)?.runId).toBe("durable-child");
  f.db.run("UPDATE agent_runs SET status='interrupted',error='budget_exhausted' WHERE id=?", [turn.runId]);
  f.db.run("UPDATE conversation_turns SET status='interrupted' WHERE id=?", [turn.turnId]);
  const continued = await memory.beginTurn({ roomId: f.room.id, threadId: thread.id, clientTurnKey: `room-command:${command.commandId}`, inputHash: "same-input", runId: "continued-child", agentId: "a", prompt: "question", parts: [] });
  expect(f.service.get(command.commandId)?.runId).toBe(continued.runId);
  expect(f.sessions.listMessages(f.room.id).filter((m) => m.role === "user")).toHaveLength(1);
  f.db.close();
});
test("stopped discussion persists partial facts and restarts as interrupted without repeating requests", async () => {
  const f = fixture(async function* (input) {
    if (input.messages[0]?.content.includes("answer")) throw new Error("second_member_failed");
    yield { type: "delta", text: "answer" }; yield { type: "done" };
  });
  const command = await f.service.submit({ roomId: f.room.id, clientRequestId: "partial", content: "question", mentions: [{ type: "all" }], intent: "respond" });
  await f.service.wait(command.commandId);
  expect(f.service.get(command.commandId)?.status).toBe("failed");
  expect(f.sessions.listMessages(f.room.id).filter((m) => m.role === "assistant")).toHaveLength(1);
  f.db.run("UPDATE room_commands SET status='running' WHERE id=?", [command.commandId]);
  f.service.recoverInterrupted();
  expect(f.service.get(command.commandId)?.status).toBe("interrupted");
  expect(f.sessions.get(f.room.id)?.status).toBe("interrupted");
  f.db.close();
});

test("orphaned command does not expose a recoverable run or dispatch again after restart", async () => {
  const f = fixture();
  const input = { roomId: f.room.id, clientRequestId: "orphan", content: "question", mentions: [], intent: "respond" as const };
  const command = await f.service.submit(input);
  const restarted = new RoomCommandService(f.db, f.sessions, {
    startDirect: async () => { throw new Error("must_not_execute"); }, getDirect: () => null,
    createTeam: async () => { throw new Error("must_not_execute"); },
    resolveAgent: () => { throw new Error("must_not_resolve"); }, gateway: async function* () {},
  });
  restarted.recoverInterrupted();
  expect(restarted.get(command.commandId)).toMatchObject({ status: "interrupted", error: "command_runtime_missing" });
  expect(restarted.get(command.commandId)?.runId).toBeUndefined();
  expect((await restarted.submit(input)).status).toBe("interrupted");
  expect(restarted.list(f.room.id).some(item => item.status === "running")).toBe(false);
  expect(f.calls()).toBe(1);
  f.db.close();
});

test("revoked discussion retains audit but cannot list, replay or submit its original request", async () => {
  const f = fixture();
  const input = { roomId: f.room.id, clientRequestId: "revoke", content: "question", mentions: [{ type: "all" as const }], intent: "respond" as const };
  const command = await f.service.submit(input);
  await f.service.wait(command.commandId);
  const user = f.sessions.listMessages(f.room.id).find(message => message.role === "user")!;
  await f.sessions.rewind(f.room.id, user.id);
  expect(f.service.get(command.commandId)?.status).toBe("revoked");
  expect(f.service.list(f.room.id)).toHaveLength(0);
  expect(f.service.eventsAfter(command.commandId, 0)).toHaveLength(0);
  expect(f.sessions.listMessages(f.room.id)).toHaveLength(0);
  await expect(f.service.submit(input)).rejects.toThrow("room_command_revoked");
  f.db.close();
});
