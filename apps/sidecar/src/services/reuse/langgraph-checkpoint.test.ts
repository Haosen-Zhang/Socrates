import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { buildReuseWorkflow, WORKFLOW_VERSION } from "./langgraph-workflow";
import { BunSqliteCheckpointSaver } from "./langgraph-checkpoint";
import { openDb } from "../../db";
import { SessionStore } from "../../store/session-store";
import { RoomCommandService } from "../room-command-service";

test("durable LangGraph interrupt resumes in another Bun process without dispatching completed service nodes again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "socrates-graph-"));
  try {
    const script = join(import.meta.dir, "langgraph-process-fixture.ts");
    const run = async (phase: string) => {
      const proc = Bun.spawn([process.execPath, script, join(dir, "graph.db"), phase], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect({ stderr, exit }).toEqual({ stderr: "", exit: 0 });
      return JSON.parse(stdout);
    };
    expect(await run("start")).toMatchObject({ interrupted: true, invocations: 1, commandStatus: "completed" });
    expect(await run("resume")).toMatchObject({ approved: true, invocations: 1, commandStatus: "completed", version: WORKFLOW_VERSION });
    expect(await run("resume")).toMatchObject({ approved: true, invocations: 1 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("aborted graph does not dispatch its service; checkpoint namespaces remain isolated", async () => {
  const db = new Database(":memory:");
  const saver = new BunSqliteCheckpointSaver(db);
  let calls = 0;
  const graph = buildReuseWorkflow(saver, async () => { calls++; return "command"; });
  const signal = AbortSignal.abort("fixture_cancel");
  await expect(graph.invoke({ request: "cancelled" }, { configurable: { thread_id: "cancelled" }, signal })).rejects.toThrow();
  expect(calls).toBe(0);
  expect(await saver.getTuple({ configurable: { thread_id: "other-room" } })).toBeUndefined();
  db.close();
});

test("in-flight graph cancellation propagates to an actual room task without completing review", async () => {
  const db = openDb(":memory:");
  const sessions = new SessionStore(db);
  const room = sessions.create({ title: "Abort fixture", mode: "chat", primaryAgentId: "a", agents: [{ agentId: "a", snapshot: {}, executionEligible: true }] });
  let providerStarted!: () => void;
  const started = new Promise<void>(resolve => { providerStarted = resolve; });
  const commands = new RoomCommandService(db, sessions, {
    startDirect: async () => { throw new Error("unexpected_direct"); }, getDirect: () => null,
    createTeam: async () => { throw new Error("unexpected_team"); },
    resolveAgent: id => ({ id, nickname: id, modelId: "fixture", providerType: "openai_compatible", baseUrl: "", apiKey: "fixture", role: "", systemPrompt: "" }),
    gateway: async function* (request) {
      providerStarted();
      await new Promise<void>(resolve => request.signal?.addEventListener("abort", () => resolve(), { once: true }));
      request.signal?.throwIfAborted();
    },
  });
  const saver = new BunSqliteCheckpointSaver(db);
  const graph = buildReuseWorkflow(saver, async (request, signal) => {
    const command = await commands.submit({ roomId: room.id, clientRequestId: "inflight-graph", content: request, intent: "discuss", mentions: [] });
    signal?.addEventListener("abort", () => { void commands.cancel(command.commandId); }, { once: true });
    if (signal?.aborted) await commands.cancel(command.commandId);
    await commands.wait(command.commandId);
    signal?.throwIfAborted();
    return command.commandId;
  });
  const controller = new AbortController();
  const result = graph.invoke({ request: "cancel while running" }, { configurable: { thread_id: "abort-service" }, signal: controller.signal });
  await started;
  controller.abort("fixture_cancel");
  await expect(result).rejects.toThrow();
  const command = commands.list(room.id)[0]!;
  await commands.wait(command.commandId);
  expect(commands.get(command.commandId)?.status).toBe("cancelled");
  expect((await graph.getState({ configurable: { thread_id: "abort-service" } })).values.approved).toBeUndefined();
  db.close();
});
