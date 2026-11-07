import { expect, test } from "bun:test";
import type { AgentRuntime, RuntimeEvent } from "@socrates/core";
import { UNKNOWN_MODEL_CAPABILITIES } from "@socrates/core";
import { openDb } from "../db";
import { SessionStore } from "../store/session-store";
import { ExecutionEventStore } from "../store/execution-event-store";
import { ApprovalManager } from "../approvals/manager";
import { AttachmentResolver } from "../attachments/resolver";
import { RuntimeManager } from "../runtime/runtime-manager";
import { SingleAgentRunner } from "../runtime/single-agent-runner";
import { RunSupervisor } from "../runtime/run-supervisor";
import { RoomCommandService } from "./room-command-service";

test("a stale quote cannot start a room command or create public history", async () => {
  const db = openDb(":memory:");
  const sessions = new SessionStore(db);
  const room = sessions.create({ mode: "chat", title: "Quote", primaryAgentId: "a",
    agents: [{ agentId: "a", snapshot: { providerId: "mock", modelId: "mock-model" }, executionEligible: true }] });
  let dispatched = false;
  const commands = new RoomCommandService(db, sessions, { startDirect: async () => { dispatched = true; return { runId: "bad" }; }, getDirect: () => null,
    createTeam: async () => ({ taskId: "unused" }), gateway: async function* () {}, resolveAgent: id => ({ id, nickname: id,
      modelId: "mock-model", role: "", systemPrompt: "", providerType: "openai_compatible", baseUrl: "", apiKey: "test" }) });
  try {
    await expect(commands.submit({ roomId: room.id, clientRequestId: "stale", content: "hello", intent: "respond", mentions: [],
      quoteId: "missing-quote", maxOutputTokens: 100 })).rejects.toThrow("quote_stale");
    expect(dispatched).toBe(false);
    expect(commands.list(room.id)).toHaveLength(0);
    expect(sessions.listMessages(room.id)).toHaveLength(0);
  } finally { db.close(); }
});

test("room command starts real supervised member pipeline once and preserves default", async () => {
  const db = openDb(":memory:");
  const sessions = new SessionStore(db), events = new ExecutionEventStore(db), approvals = new ApprovalManager(db);
  const runtimes = new RuntimeManager(db, events);
  let starts = 0;
  class ModelStub implements AgentRuntime {
    kind = "native_ai_sdk"; capabilities = { ...UNKNOWN_MODEL_CAPABILITIES };
    async open() {} async close() {} async interrupt() {} async answerApproval() {}
    async *start(): AsyncIterable<RuntimeEvent> { starts++; yield { type: "status", status: "running" }; yield { type: "text_delta", text: "member reply" }; yield { type: "status", status: "completed" }; }
  }
  runtimes.register("native_ai_sdk", () => new ModelStub());
  const runner = new SingleAgentRunner(db, runtimes, approvals, events, new AttachmentResolver(db, "/tmp"));
  const supervisor = new RunSupervisor(runner);
  const room = sessions.create({ mode: "chat", title: "Chat", primaryAgentId: "a", agents: ["a", "b"].map((agentId) => ({ agentId, snapshot: { providerId: "mock", modelId: "mock-model" }, executionEligible: true })) });
  const commands = new RoomCommandService(db, sessions, { startDirect: (input) => supervisor.start(input), getDirect: (id) => supervisor.get(id), createTeam: async () => ({ taskId: "unused" }), gateway: async function* () {}, resolveAgent: (id) => ({ id, nickname: id, modelId: "mock-model", role: "", systemPrompt: "", providerType: "openai_compatible", baseUrl: "", apiKey: "mock" }) });
  const input = { roomId: room.id, clientRequestId: "request", content: "@b do it", intent: "respond" as const, mentions: [{ type: "agent" as const, agentId: "b" }] };
  const command = await commands.submit(input);
  for (let attempt = 0; attempt < 50 && commands.get(command.commandId)?.status !== "completed"; attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(commands.get(command.commandId)?.status).toBe("completed");
  const replay = await commands.submit(input);
  expect(replay.runId).toBe(command.runId);
  expect(starts).toBe(1);
  expect(sessions.get(room.id)!.primaryAgentId).toBe("a");
  expect(sessions.listMessages(room.id).filter((m) => m.role === "user")).toHaveLength(1);
  expect(sessions.listMessages(room.id).filter((m) => m.role === "assistant")[0]?.authorId).toBe("b");
  sessions.updateAgentSnapshot(room.id, "b", { providerId: "mock", modelId: "changed-model", nickname: "Changed" });
  expect(sessions.listMessages(room.id).filter((m) => m.role === "assistant")[0]?.authorSnapshot?.modelId).toBe("mock-model");
  await supervisor.shutdown();
  db.close();
});
