import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { ModelGateway, OrchestrationAgent } from "@socrates/core";
import { openDb } from "../db";
import { SessionStore } from "../store/session-store";
import { ConversationMemoryStore } from "../store/conversation-memory-store";
import { EventStore } from "../store/event-store";
import { MultiTaskStore } from "../multi-agent/task-store";
import { MultiAgentCoordinator } from "../multi-agent/coordinator";
import { RoomCommandService } from "./room-command-service";
import { roomCommandRoutes } from "../routes/room-commands";
import { buildPublicRoomContext } from "./public-room-context";

const PLAN = JSON.stringify({ objective: "implement", summary: "honor prior constraints", steps: [{ id: "1", title: "implement", description: "make requested changes", files: [], commands: [], risks: [], verification: ["run tests"] }], evidence: [], workPackages: [{ id: "work", title: "implement", objective: "make requested changes", input: "use prior constraints", dependencies: [], executorAgentId: "a", reviewerAgentId: null, expectedFiles: [], acceptanceCriteria: ["run tests"] }] });
const REQUEST = "Continue implementing the requirements we just agreed.";

function fixture(gateway: ModelGateway, discussion = false, reviewer = false) {
  const db = openDb(":memory:");
  const now = new Date().toISOString();
  db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES ('w', '/tmp', '/tmp', 'hash', 'tmp', ?, ?)").run(now, now);
  const sessions = new SessionStore(db);
  const room = sessions.create({ title: "Work", kind: "cowork", mode: "multi_agent", workspaceId: "w", primaryAgentId: "a", agents: ["a", "b"].map(agentId => ({ agentId, snapshot: { nickname: agentId.toUpperCase(), modelId: "m" }, executionEligible: true })) });
  sessions.updateCollaboration(room.id, { ...room.collaboration, strategy: "team", assignment: { ...room.collaboration.assignment, coordinatorAgentId: "a" }, discussion: { enabled: discussion, mode: "round_robin", maxRounds: 1, speakerOrder: ["a", "b"], summaryAgentId: discussion ? "a" : null }, planConfirmation: reviewer ? { mode: "reviewer", reviewerAgentId: "b" } : room.collaboration.planConfirmation });
  const events = new EventStore(db), tasks = new MultiTaskStore(db), memory = new ConversationMemoryStore(db);
  const resolve = (id: string): OrchestrationAgent => ({ id, nickname: id.toUpperCase(), modelId: "m", role: `member ${id}`, systemPrompt: "own member instructions", providerType: "openai_compatible", baseUrl: "", apiKey: "fixture" });
  const coordinator = new MultiAgentCoordinator(db, tasks, events, gateway, resolve);
  let completion: Promise<void> = Promise.resolve();
  const dependencies = {
    startDirect: async () => ({ runId: "unused" }), getDirect: () => null, gateway, resolveAgent: resolve,
    createTeam: async ({ sessionId, prompt, clientRequestId, targetAgentIds, inputContext }: { sessionId: string; prompt: string; clientRequestId: string; targetAgentIds: string[]; inputContext: string }) => {
      const task = await coordinator.create({ sessionId, prompt, config: { speakingOrder: ["a", "b"], maxRounds: 1, synthesizerId: "a", executionAgentId: "a", teamExecution: true, clientRequestId, targetAgentIds, inputContext } });
      completion = coordinator.run(task.id);
      return { taskId: task.id };
    },
  };
  const commands = new RoomCommandService(db, sessions, dependencies);
  const addMessage = async (content: string, role: "user" | "assistant" = "user", roomId = room.id) => {
    const thread = memory.ensureDefaultThread(roomId);
    return memory.appendMessage({ roomId, threadId: thread.id, runId: null, turnId: null, agentId: role === "assistant" ? "b" : null, role, kind: "text", content, parts: [{ type: "text", text: content }], status: "completed", idempotencyKey: crypto.randomUUID() });
  };
  return { db, sessions, room, events, tasks, coordinator, commands, dependencies, addMessage, settled: () => completion };
}

for (const discussion of [false, true]) test(`Team gateway includes frozen public roles and authors with discussion=${discussion}`, async () => {
  const captured: Parameters<ModelGateway>[0][] = [];
  const f = fixture(async function* (request) {
    captured.push(request);
    yield { type: "delta", text: (request.system ?? "").includes("designated reviewer") ? '{"verdict":"approve","notes":"constraints honored"}' : (request.system ?? "").includes("synthesize a coding discussion") ? PLAN : "current task discussion" };
    yield { type: "done" };
  }, discussion, true);
  await f.addMessage("Keep the protected baseline read-only.");
  await f.addMessage("Agreed: export changes into an independent output directory.", "assistant");
  const other = f.sessions.create({ title: "other", mode: "chat", primaryAgentId: "a", agents: [{ agentId: "a", snapshot: {}, executionEligible: true }] });
  await f.addMessage("OTHER ROOM SECRET", "user", other.id);
  const command = await f.commands.submit({ roomId: f.room.id, clientRequestId: "request", content: REQUEST, intent: "execute", mentions: [] });
  await f.settled();
  expect(f.tasks.get(command.taskId!)?.state).toBe("awaiting_plan_approval");
  expect(captured.length).toBe(discussion ? 4 : 2);
  for (const request of captured) {
    const context = JSON.stringify(request.messages);
    expect(context).toContain("Keep the protected baseline read-only.");
    expect(context).toContain("independent output directory");
    expect(request.messages[0]!.content).toContain('"role":"assistant","authorId":"b"');
    expect(context).not.toContain("OTHER ROOM SECRET");
    expect(request.system).not.toContain("protected baseline");
    expect(context.split(REQUEST).length - 1).toBe(1);
  }
  const task = f.tasks.get(command.taskId!)!;
  const frozen = buildPublicRoomContext(f.db, { sessionId: f.room.id, cursor: task.config.contextMessageCursor!, taskId: task.id, request: task.prompt });
  await f.addMessage("POST CURSOR must never leak into this task");
  f.tasks.transition(task.id, { type: "request_replan" });
  await f.coordinator.replan(task.id, "Retain all prior requirements and add verification.");
  expect(captured.at(-1)!.messages[0]!.content).toContain(frozen);
  expect(captured.at(-1)!.messages[0]!.content).toContain("Retain all prior requirements");
  expect(captured.at(-1)!.messages[0]!.content).not.toContain("POST CURSOR");
  if (discussion) expect(captured.at(-1)!.messages[0]!.content).toContain("current task discussion");
  f.db.close();
});

test("paused Manager retry retains its cursor and appends new durable member events", async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const captured: string[] = [];
  const f = fixture(async function* (request) {
    captured.push(request.messages[0]!.content);
    if (captured.length === 1) {
      started();
      await new Promise<void>((_resolve, reject) => request.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }
    yield { type: "delta", text: PLAN }; yield { type: "done" };
  });
  await f.addMessage("Frozen constraint: output only to isolated directory.");
  const command = await f.commands.submit({ roomId: f.room.id, clientRequestId: "retry", content: REQUEST, intent: "execute", mentions: [] });
  await ready;
  f.coordinator.pause(command.taskId!);
  await f.settled();
  const before = f.commands.eventsAfter(command.commandId, 0);
  await f.addMessage("POST CURSOR constraint change");
  await f.coordinator.resume(command.taskId!);
  expect(captured).toHaveLength(2);
  expect(captured[1]).toBe(captured[0]);
  expect(f.tasks.get(command.taskId!)?.attemptNo).toBe(2);
  const after = f.commands.eventsAfter(command.commandId, before.at(-1)!.seq);
  expect(after.some(event => event.type === "delta" && event.agentId === "a" && typeof event.turnId === "string")).toBe(true);
  expect(after.every(event => event.roomId === f.room.id && event.taskId === command.taskId && event.seq > before.at(-1)!.seq)).toBe(true);
  f.db.close();
});

test("Team SSE streams before completion, reconnects by durable sequence, and drains terminal pages", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async function* () { yield { type: "delta", text: "live-" }; await gate; yield { type: "delta", text: PLAN }; yield { type: "done" }; });
  const command = await f.commands.submit({ roomId: f.room.id, clientRequestId: "stream", content: REQUEST, intent: "execute", mentions: [] });
  const app = new Hono().route("/room-commands", roomCommandRoutes(f.commands));
  const controller = new AbortController();
  const response = await app.request(`/room-commands/${command.commandId}/events`, { signal: controller.signal });
  const reader = response.body!.getReader();
  let content = "";
  for (let i = 0; i < 20 && !content.includes('"text":"live-"'); i++) content += new TextDecoder().decode((await reader.read()).value);
  expect(content).toContain('"type":"delta"');
  expect(content).toContain('"text":"live-"');
  expect(f.tasks.get(command.taskId!)?.state).toBe("synthesizing");
  controller.abort(); await reader.cancel();
  release(); await f.settled(); // Invalid streamed JSON fails after repair; delivery remains durable.
  const first = f.commands.eventsAfter(command.commandId, 0);
  const cursor = first.at(-1)!.seq;
  const runtimeEvent = { eventId: "worker-delta", sessionId: f.room.id, taskId: command.taskId, type: "multi.package_runtime", payload: { packageId: "package", runId: "worker", agentId: "b", event: { type: "text_delta", text: "worker output" } } };
  f.events.append(runtimeEvent); f.events.append(runtimeEvent);
  for (let i = 0; i < 510; i++) f.events.append({ ...runtimeEvent, eventId: `worker-${i}` });
  const restarted = new RoomCommandService(f.db, f.sessions, f.dependencies);
  const replayApp = new Hono().route("/room-commands", roomCommandRoutes(restarted));
  const replay = await (await replayApp.request(`/room-commands/${command.commandId}/events?afterSeq=${cursor}`)).text();
  expect((replay.match(/event: multi.package_runtime/g) ?? []).length).toBe(511);
  expect(replay).not.toContain('"text":"live-"');
  expect(replay).toContain('"agentId":"b"');
  expect(replay).toContain('"eventId":"worker-delta"');
  f.db.close();
});

test("public context budget retains whole JSON message boundaries and actual authors", async () => {
  const f = fixture(async function* () {});
  await f.addMessage("old ".repeat(1000));
  await f.addMessage("new constraint", "assistant");
  const cursor = f.db.query<{ cursor: number }, []>("SELECT MAX(rowid) AS cursor FROM session_messages").get()!.cursor;
  const result = buildPublicRoomContext(f.db, { sessionId: f.room.id, cursor, maxBytes: 800 });
  expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(800);
  const parsed = JSON.parse(result.slice(result.indexOf("\n") + 1));
  expect(parsed.messages).toHaveLength(1);
  expect(parsed.messages[0]).toMatchObject({ role: "assistant", authorId: "b", content: "new constraint" });
  expect(parsed.omittedMessages).toBe(1);
  f.db.close();
});

test("recoverable plan-review failure keeps the Team command observable for human approval", async () => {
  const f = fixture(async function* (request) {
    yield { type: "delta", text: (request.system ?? "").includes("designated reviewer") ? "unparseable review" : PLAN };
    yield { type: "done" };
  }, false, true);
  const command = await f.commands.submit({ roomId: f.room.id, clientRequestId: "review-recovery", content: REQUEST, intent: "execute", mentions: [] });
  await f.settled();
  expect(f.commands.get(command.commandId)).toMatchObject({ status: "awaiting_plan_approval", error: "review_output_invalid" });
  const events = f.commands.eventsAfter(command.commandId, 0);
  expect(events.find(event => event.type === "multi.review_failed")).toMatchObject({ requiresHumanReview: true });
  expect(events.some(event => event.type === "task_failed")).toBe(false);
  expect(events.at(-1)).toMatchObject({ type: "task_state", state: "awaiting_plan_approval" });
  const plan = f.tasks.getPlan(command.taskId!)!;
  f.tasks.decidePlan({ taskId: command.taskId!, version: plan.version, hash: plan.contentHash, decision: "approve_exact_plan", clientDecisionKey: "human-reviewed" });
  expect(f.commands.get(command.commandId)?.status).toBe("executing");
  const cursor = events.at(-1)!.seq;
  f.events.append({ eventId: "after-human-approval", sessionId: f.room.id, taskId: command.taskId, type: "multi.package_runtime", payload: { runId: "worker", agentId: "a", event: { type: "text_delta", text: "continuing after review" } } });
  expect(f.commands.eventsAfter(command.commandId, cursor)).toHaveLength(1);
  f.db.close();
});
