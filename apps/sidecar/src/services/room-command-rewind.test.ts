import { expect, test } from "bun:test";
import { DEFAULT_COLLABORATION_SETTINGS } from "@socrates/core";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db";
import { SessionStore } from "../store/session-store";
import { ConversationMemoryStore } from "../store/conversation-memory-store";
import { HistoryStore } from "../store/history-store";
import { RoomCommandService } from "./room-command-service";
for (const kind of ["direct", "discussion"] as const) test(`${kind}: rewind revokes command and replay across HistoryStore/service restart`, async () => {
  const root = mkdtempSync(join(tmpdir(), "socrates-rewind-command-")); const db = openDb(":memory:");
  try {
    let history = new HistoryStore(db, root), sessions = new SessionStore(db, history), memory = new ConversationMemoryStore(db, history);
    const room = sessions.create({ title: "room", mode: "chat", primaryAgentId: "a", agents: ["a", "b"].map(agentId => ({ agentId, snapshot: { nickname: agentId }, executionEligible: true })) });
    const deps = {
      startDirect: async (input: { clientTurnKey: string; prompt: string }) => {
        const thread = memory.ensureDefaultThread(room.id);
        const turn = await memory.beginTurn({ roomId: room.id, threadId: thread.id, clientTurnKey: input.clientTurnKey, inputHash: "h", runId: "direct-run", agentId: "a", prompt: input.prompt, parts: [] });
        await memory.completeTurn({ roomId: room.id, runId: turn.runId, turnId: turn.turnId, completedAt: new Date().toISOString(), assistantMessage: { roomId: room.id, threadId: thread.id, runId: turn.runId, turnId: turn.turnId, agentId: "a", role: "assistant", kind: "text", content: "answer", parts: [], status: "completed", idempotencyKey: "answer" } });
        return { runId: turn.runId };
      },
      getDirect: (id: string) => db.query<{ status: string }, [string]>("SELECT status FROM agent_runs WHERE id=?").get(id),
      createTeam: async () => ({ taskId: "unused" }),
      resolveAgent: (id: string) => ({ id, nickname: id, role: "", systemPrompt: "", providerType: "openai_compatible" as const, baseUrl: "", apiKey: "test", modelId: "m" }),
      gateway: async function* () { yield { type: "delta" as const, text: "answer" }; yield { type: "done" as const }; },
    };
    let service = new RoomCommandService(db, sessions, deps, history);
    const input = { roomId: room.id, clientRequestId: "original-request", content: "question", mentions: kind === "discussion" ? [{ type: "all" as const }] : [], intent: "respond" as const };
    const command = await service.submit(input); await service.wait(command.commandId);
    expect(service.get(command.commandId)?.status).toBe("completed");
    const first = sessions.listMessages(room.id)[0]!;
    await sessions.rewind(room.id, first.id);
    history = new HistoryStore(db, root); sessions = new SessionStore(db, history); memory = new ConversationMemoryStore(db, history);
    service = new RoomCommandService(db, sessions, deps, history);
    await history.bootstrapAll(); service.recoverInterrupted();
    expect(sessions.listMessages(room.id)).toEqual([]);
    expect(service.list(room.id)).toEqual([]);
    expect(service.get(command.commandId)).toMatchObject({ status: "revoked" });
    expect(service.get(command.commandId)?.runId).toBeUndefined();
    expect(service.eventsAfter(command.commandId, 0)).toEqual([]);
    await expect(service.submit(input)).rejects.toThrow("room_command_revoked");
    expect(sessions.listMessages(room.id)).toEqual([]);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const crashBeforeProjection of [false, true]) test(`continued direct rewind invalidates every attempt${crashBeforeProjection ? " after projection recovery" : ""}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "socrates-rewind-attempts-")); const db = openDb(":memory:");
  try {
    let history = new HistoryStore(db, root), sessions = new SessionStore(db, history), memory = new ConversationMemoryStore(db, history);
    const room = sessions.create({ title: "room", mode: "chat", primaryAgentId: "a", agents: [{ agentId: "a", snapshot: { nickname: "a" }, executionEligible: true }] });
    const thread = memory.ensureDefaultThread(room.id);
    const deps = {
      startDirect: async (input: { clientTurnKey: string; prompt: string }) => {
        const turn = await memory.beginTurn({ roomId: room.id, threadId: thread.id, clientTurnKey: input.clientTurnKey, inputHash: "h", runId: "first-attempt", agentId: "a", prompt: input.prompt, parts: [] });
        await memory.terminateTurn({ roomId: room.id, runId: turn.runId, turnId: turn.turnId, status: "interrupted", error: "budget_exhausted", completedAt: new Date().toISOString() });
        return { runId: turn.runId };
      },
      getDirect: (id: string) => db.query<{ status: string }, [string]>("SELECT status FROM agent_runs WHERE id=?").get(id), createTeam: async () => ({ taskId: "unused" }),
      resolveAgent: (id: string) => ({ id, nickname: id, role: "", systemPrompt: "", providerType: "openai_compatible" as const, baseUrl: "", apiKey: "test", modelId: "m" }),
      gateway: async function* () { yield { type: "done" as const }; },
    };
    let service = new RoomCommandService(db, sessions, deps, history);
    const input = { roomId: room.id, clientRequestId: "continued-request", content: "question", mentions: [], intent: "respond" as const };
    const command = await service.submit(input);
    const second = await memory.beginTurn({ roomId: room.id, threadId: thread.id, clientTurnKey: `room-command:${command.commandId}`, inputHash: "h", runId: "second-attempt", agentId: "a", prompt: "question", parts: [] });
    await memory.completeTurn({ roomId: room.id, runId: second.runId, turnId: second.turnId, completedAt: new Date().toISOString(), assistantMessage: { messageId: "continued-answer", roomId: room.id, threadId: thread.id, runId: second.runId, turnId: second.turnId, agentId: "a", role: "assistant", kind: "text", content: "finished", parts: [], status: "completed", idempotencyKey: "continued-answer" } });
    expect(service.get(command.commandId)?.runId).toBe("second-attempt");
    if (crashBeforeProjection) {
      db.exec("CREATE TRIGGER fail_rewind_projection BEFORE UPDATE ON sessions WHEN NEW.status = 'idle' BEGIN SELECT RAISE(ABORT, 'injected_rewind_failure'); END");
      await expect(sessions.rewind(room.id, "continued-answer")).rejects.toThrow("injected_rewind_failure");
      db.exec("DROP TRIGGER fail_rewind_projection");
    } else await sessions.rewind(room.id, "continued-answer");
    history = new HistoryStore(db, root); sessions = new SessionStore(db, history); memory = new ConversationMemoryStore(db, history);
    service = new RoomCommandService(db, sessions, deps, history);
    await history.bootstrapAll(); service.recoverInterrupted();
    expect(db.query("SELECT id FROM agent_runs WHERE session_id=?").all(room.id)).toEqual([]);
    expect(service.get(command.commandId)?.status).toBe("revoked");
    expect(service.list(room.id)).toEqual([]);
    expect(service.eventsAfter(command.commandId, 0)).toEqual([]);
    expect(sessions.listMessages(room.id).map(message => message.content)).toEqual(["question"]);
    await expect(service.submit(input)).rejects.toThrow("room_command_revoked");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const crashBeforeProjection of [false, true]) test(`rewinding a Team child removes parent/package recovery projections${crashBeforeProjection ? " after projection recovery" : ""}`, async () => {
  const { MultiTaskStore } = await import("../multi-agent/task-store");
  const { WorkPackageStore } = await import("../multi-agent/work-package-store");
  const { EventStore } = await import("../store/event-store");
  const { UsageCollector, normalizeTokenUsage } = await import("./usage-collector");
  const root = mkdtempSync(join(tmpdir(), "socrates-rewind-team-")); const db = openDb(":memory:");
  try {
    let history = new HistoryStore(db, root), sessions = new SessionStore(db, history), memory = new ConversationMemoryStore(db, history);
    db.query("INSERT INTO workspaces(id,canonical_path,display_path,identity_hash,label,created_at,last_opened_at) VALUES ('w',?,?,'h','temp','now','now')").run(root, root);
    const room = sessions.create({ title: "room", mode: "multi_agent", kind: "cowork", workspaceId: "w", collaborationDefaults: { ...DEFAULT_COLLABORATION_SETTINGS, strategy: "team" }, primaryAgentId: "a", agents: ["a", "b"].map(agentId => ({ agentId, snapshot: { nickname: agentId }, executionEligible: true })) });
    let tasks = new MultiTaskStore(db, history);
    const packages = new WorkPackageStore(db), events = new EventStore(db), usage = new UsageCollector(db);
    const deps = { startDirect: async () => ({ runId: "unused" }), getDirect: () => null,
      resolveAgent: (id: string) => ({ id, nickname: id, role: "", systemPrompt: "", providerType: "openai_compatible" as const, baseUrl: "", apiKey: "test", modelId: "m" }),
      gateway: async function* () { yield { type: "done" as const }; }, createTeam: async (input: { prompt: string; clientRequestId: string }) => {
      const task = await tasks.create({ sessionId: room.id, prompt: input.prompt, config: { speakingOrder: ["a", "b"], maxRounds: 1, synthesizerId: "a", executionAgentId: "b", teamExecution: true, clientRequestId: input.clientRequestId } });
      tasks.transition(task.id, { type: "prepared_multi" }); tasks.transition(task.id, { type: "discussion_complete" });
      const plan = await tasks.addPlan({ taskId: task.id, createdBy: "a", content: { objective: "work", summary: "work", evidence: [], steps: [{ id: "one", title: "work", description: "work", files: [], commands: [], risks: [], verification: [] }], workPackages: [{ id: "child", title: "work", objective: "work", input: "work", dependencies: [], executorAgentId: "b", reviewerAgentId: null, expectedFiles: [], acceptanceCriteria: ["done"] }] } });
      tasks.transition(task.id, { type: "plan_ready" }); tasks.decidePlan({ taskId: task.id, version: plan.version, hash: plan.contentHash, clientDecisionKey: "approved", decision: "approve_exact_plan" });
      const item = packages.start(packages.list(task.id)[0]!.id);
      await memory.appendMessage({ messageId: "team-child-answer", roomId: room.id, threadId: memory.ensureDefaultThread(room.id).id, runId: item.runId!, turnId: item.runId!, agentId: "b", role: "assistant", kind: "text", content: "child finished", parts: [], status: "completed", idempotencyKey: "team-child-answer" });
      packages.finish(item.id, { status: "completed", runId: item.runId!, result: "child finished" });
      usage.record({ stableKey: "child", sessionId: room.id, taskId: item.runId!, agentId: "b", usage: normalizeTokenUsage({ inputTokens: 100, outputTokens: 25 }) });
      events.append({ eventId: "child-event", sessionId: room.id, taskId: task.id, type: "multi.package_runtime", payload: { event: { type: "text_delta", text: "child finished" } } });
      tasks.transition(task.id, { type: "complete" });
      return { taskId: task.id };
    } };
    let service = new RoomCommandService(db, sessions, deps, history);
    const input = { roomId: room.id, clientRequestId: "team-request", content: "work", mentions: [], intent: "execute" as const };
    const command = await service.submit(input);
    expect(service.eventsAfter(command.commandId, 0)).toHaveLength(1);
    if (crashBeforeProjection) {
      db.exec("CREATE TRIGGER fail_team_rewind BEFORE UPDATE ON sessions WHEN NEW.status = 'idle' BEGIN SELECT RAISE(ABORT, 'injected_team_rewind_failure'); END");
      await expect(sessions.rewind(room.id, "team-child-answer")).rejects.toThrow("injected_team_rewind_failure");
      db.exec("DROP TRIGGER fail_team_rewind");
    } else await sessions.rewind(room.id, "team-child-answer");
    history = new HistoryStore(db, root); sessions = new SessionStore(db, history); memory = new ConversationMemoryStore(db, history); tasks = new MultiTaskStore(db, history);
    service = new RoomCommandService(db, sessions, deps, history);
    await history.bootstrapAll(); service.recoverInterrupted();
    expect(tasks.list(room.id)).toEqual([]);
    expect(packages.list(command.taskId!)).toEqual([]);
    expect(usage.sessionSummaries(room.id)).toEqual([]);
    expect(service.get(command.commandId)?.status).toBe("revoked");
    expect(service.eventsAfter(command.commandId, 0)).toEqual([]);
    expect(sessions.listMessages(room.id).map(message => message.content)).toEqual(["work"]);
    await expect(service.submit(input)).rejects.toThrow("room_command_revoked");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
