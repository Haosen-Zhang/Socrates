import { describe, expect, it } from "bun:test";
import type {
  AgentRuntime,
  ApprovalDecision,
  RuntimeConversationMessage,
  RuntimeEvent,
} from "@socrates/core";
import { executionEventToRuntimeEvent, UNKNOWN_MODEL_CAPABILITIES } from "@socrates/core";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { openDb } from "../db";
import { ApprovalManager } from "../approvals/manager";
import { ExecutionEventStore } from "../store/execution-event-store";
import { SessionStore } from "../store/session-store";
import { ConversationMemoryStore } from "../store/conversation-memory-store";
import { RuntimeManager } from "./runtime-manager";
import { SingleAgentRunner } from "./single-agent-runner";
import { RunSupervisor } from "./run-supervisor";
import { estimateNativeContextOverhead } from "./native-agent-runtime";
import { AttachmentResolver } from "../attachments/resolver";
import { tmpdir } from "node:os";
import { WorkspacePathPolicy } from "../workspace/path-policy";
import { createReadOnlyBuiltins } from "../tools/read-only-builtins";
import { createWorkspaceWriteBuiltins } from "../tools/workspace-write-builtins";

class ApprovalRuntime implements AgentRuntime {
  readonly kind = "fake";
  readonly capabilities = { ...UNKNOWN_MODEL_CAPABILITIES, textInput: true as const, toolCalling: true as const };
  private resolve: ((decision: ApprovalDecision) => void) | null = null;
  private pendingDecision: ApprovalDecision | null = null;
  async open() {}
  async *start(): AsyncIterable<RuntimeEvent> {
    yield { type: "status", status: "running" };
    yield { type: "tool_call", callId: "call", name: "shell_command", input: { command: "pwd", cwd: "." } };
    yield { type: "approval_required", requestId: "call", callId: "call" };
    const decision = this.pendingDecision ?? await new Promise<ApprovalDecision>((resolve) => { this.resolve = resolve; });
    yield { type: "extension", name: "approval_result", payload: decision };
    yield { type: "text_delta", text: "done" };
    yield { type: "status", status: "completed" };
  }
  async answerApproval(_requestId: string, decision: ApprovalDecision) {
    if (this.resolve) this.resolve(decision);
    else this.pendingDecision = decision;
  }
  async interrupt() {}
  async close() {}
}

class FlakyApprovalDeliveryRuntime extends ApprovalRuntime {
  attempts = 0;
  override async answerApproval(requestId: string, decision: ApprovalDecision) {
    this.attempts += 1;
    if (this.attempts === 1) throw new Error("approval_delivery_failed");
    await super.answerApproval(requestId, decision);
  }
}

class CancellableApprovalRuntime implements AgentRuntime {
  readonly kind = "cancellable-approval";
  readonly capabilities = {
    ...UNKNOWN_MODEL_CAPABILITIES, textInput: true as const, toolCalling: true as const,
  };
  private resolve: ((decision: ApprovalDecision) => void) | null = null;
  private reject: ((error: Error) => void) | null = null;
  private interrupted = false;
  async open() {}
  async *start(input: { signal?: AbortSignal } = {}): AsyncIterable<RuntimeEvent> {
    yield { type: "status", status: "running" };
    yield { type: "tool_call", callId: "call", name: "shell_command", input: { command: "pwd" } };
    yield { type: "approval_required", requestId: "call", callId: "call" };
    if (this.interrupted || input.signal?.aborted) throw new Error("interrupted");
    await new Promise<ApprovalDecision>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    yield { type: "text_delta", text: "done" };
  }
  async answerApproval(_requestId: string, decision: ApprovalDecision) {
    this.resolve?.(decision);
  }
  async interrupt() {
    this.interrupted = true;
    this.reject?.(new Error("interrupted"));
  }
  async close() {}
}

class InterruptibleRuntime implements AgentRuntime {
  readonly kind = "interruptible";
  readonly capabilities = { ...UNKNOWN_MODEL_CAPABILITIES, textInput: true as const };
  private reject: ((error: Error) => void) | null = null;
  private interrupted = false;
  async open() {}
  async *start(): AsyncIterable<RuntimeEvent> {
    yield { type: "status", status: "running" };
    yield { type: "text_delta", text: "confirmed partial" };
    if (this.interrupted) throw new Error("interrupted");
    await new Promise<never>((_resolve, reject) => { this.reject = reject; });
  }
  async answerApproval() {}
  async interrupt() {
    this.interrupted = true;
    this.reject?.(new Error("interrupted"));
  }
  async close() {}
}

class ThrowingInterruptRuntime implements AgentRuntime {
  readonly kind = "throwing-interrupt";
  readonly capabilities = { ...UNKNOWN_MODEL_CAPABILITIES, textInput: true as const };
  interruptCalls = 0;
  private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });
  async open() {}
  async *start(input: { signal?: AbortSignal } = {}): AsyncIterable<RuntimeEvent> {
    this.markStarted();
    yield { type: "status", status: "running" };
    await new Promise<void>((_resolve, reject) => {
      input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }
  async answerApproval() {}
  async interrupt() {
    this.interruptCalls += 1;
    throw new Error("runtime_interrupt_failed");
  }
  async close() {}
}

class RecordingRuntime implements AgentRuntime {
  readonly kind = "recording";
  readonly capabilities = { ...UNKNOWN_MODEL_CAPABILITIES, textInput: true as const, toolCalling: true as const };
  constructor(
    private readonly seen: RuntimeConversationMessage[][],
    private readonly response: string,
    private readonly withTool = false,
    private readonly overheadTokens = 0,
  ) {}
  contextOverheadTokens(): number { return this.overheadTokens; }
  async open() {}
  async *start(input: { messages?: RuntimeConversationMessage[] }): AsyncIterable<RuntimeEvent> {
    this.seen.push(input.messages ?? []);
    if (this.withTool) {
      yield { type: "text_delta", text: "checking first" };
      yield { type: "tool_call", callId: "read-call", name: "read_file", input: { path: "note.txt" } };
      yield {
        type: "tool_result",
        callId: "read-call",
        name: "read_file",
        output: { preview: "stored result", byteSize: 13, truncated: false },
        isError: false,
      };
    }
    yield { type: "text_delta", text: this.response };
  }
  async answerApproval() {}
  async interrupt() {}
  async close() {}
}

class FlakyRuntime implements AgentRuntime {
  readonly kind = "flaky";
  readonly capabilities = { ...UNKNOWN_MODEL_CAPABILITIES, textInput: true as const };
  constructor(private readonly attempts: { count: number }) {}
  async open() {}
  async *start(): AsyncIterable<RuntimeEvent> {
    this.attempts.count += 1;
    if (this.attempts.count === 1) throw new Error("temporary_provider_failure");
    yield { type: "text_delta", text: "recovered" };
  }
  async answerApproval() {}
  async interrupt() {}
  async close() {}
}

class PublicSummaryRuntime implements AgentRuntime {
  readonly kind = "public-summary";
  readonly capabilities = { ...UNKNOWN_MODEL_CAPABILITIES, textInput: true as const };
  async open() {}
  async *start(): AsyncIterable<RuntimeEvent> {
    yield {
      type: "extension",
      name: "reasoning_summary_delta",
      payload: { text: "Checked the public constraints." },
    };
    yield { type: "text_delta", text: "done" };
  }
  async answerApproval() {}
  async interrupt() {}
  async close() {}
}

function setup() {
  const db = openDb(":memory:");
  db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("w", "/tmp/w", "/tmp/w", "workspace-hash", "w", "now", "now");
  const session = new SessionStore(db).create({
    title: "Solo", mode: "single_agent", workspaceId: "w",
    primaryAgentId: "a",
    agents: [{ agentId: "a", snapshot: { nickname: "A" }, executionEligible: true }],
  });
  const approvals = new ApprovalManager(db);
  const events = new ExecutionEventStore(db);
  const runtimes = new RuntimeManager(db, events);
  runtimes.register("fake", () => new ApprovalRuntime());
  runtimes.register("public-summary", () => new PublicSummaryRuntime());
  return { db, session, approvals, runner: new SingleAgentRunner(db, runtimes, approvals, events, new AttachmentResolver(db, `${tmpdir()}/unused-${crypto.randomUUID()}`)) };
}

function setupRecording(
  options: {
    dbPath?: string;
    response?: string;
    withTool?: boolean;
    seen?: RuntimeConversationMessage[][];
    attachmentRoot?: string;
    contextOverheadTokens?: number;
    unknownContextWindow?: boolean;
  } = {},
) {
  const db = openDb(options.dbPath ?? ":memory:");
  const existingWorkspace = db.query("SELECT id FROM workspaces WHERE id = 'w'").get();
  if (!existingWorkspace) {
    db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("w", "/tmp/w", "/tmp/w", "workspace-hash", "w", "now", "now");
  }
  const store = new SessionStore(db);
  const session = store.list()[0] ?? store.create({
    title: "Solo", mode: "single_agent", workspaceId: "w",
    primaryAgentId: "a",
    agents: [{
      agentId: "a",
      snapshot: {
        nickname: "A",
        modelCapabilities: options.unknownContextWindow ? {} : { contextWindowTokens: 32_768 },
      },
      executionEligible: true,
    }],
  });
  const seen = options.seen ?? [];
  const approvals = new ApprovalManager(db);
  const events = new ExecutionEventStore(db);
  const runtimes = new RuntimeManager(db, events);
  runtimes.register("recording", () => new RecordingRuntime(
    seen,
    options.response ?? `answer-${seen.length + 1}`,
    options.withTool ?? false,
    options.contextOverheadTokens ?? 0,
  ));
  const attachmentRoot = options.attachmentRoot
    ?? `${tmpdir()}/socrates-runner-attachments-${crypto.randomUUID()}`;
  const attachments = new AttachmentResolver(db, attachmentRoot);
  const runner = new SingleAgentRunner(
    db,
    runtimes,
    approvals,
    events,
    attachments,
  );
  return { db, session, seen, runner, attachments, attachmentRoot };
}

function setContextWindow(db: ReturnType<typeof openDb>, sessionId: string, tokens: number): void {
  const row = db.query<{ agent_id: string; snapshot_json: string }, [string]>(`
    SELECT agent_id, snapshot_json FROM session_agents WHERE session_id = ?
  `).get(sessionId);
  if (!row) throw new Error("test_agent_missing");
  const snapshot = JSON.parse(row.snapshot_json) as Record<string, unknown>;
  const capabilities = snapshot.modelCapabilities && typeof snapshot.modelCapabilities === "object"
    ? snapshot.modelCapabilities as Record<string, unknown>
    : {};
  db.query(`
    UPDATE session_agents SET snapshot_json = ?
    WHERE session_id = ? AND agent_id = ?
  `).run(
    JSON.stringify({
      ...snapshot,
      modelCapabilities: { ...capabilities, contextWindowTokens: tokens },
    }),
    sessionId,
    row.agent_id,
  );
}

describe("SingleAgentRunner", () => {
  it("records one reconstructable Run lifecycle only in the execution journal", async () => {
    const { db, session, runner } = setupRecording({ response: "done" });
    const result = await runner.run({
      sessionId: session.id,
      runtimeKind: "recording",
      clientTurnKey: "execution-lifecycle",
      prompt: "record the lifecycle",
    });

    expect(db.query<{ type: string }, [string]>(
      "SELECT type FROM runtime_events WHERE run_id = ? ORDER BY seq",
    ).all(result.id).map(({ type }) => type)).toEqual([
      "run.created",
      "run.started",
      "runtime.event",
      "run.completed",
    ]);
    expect(db.query("SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?").get(result.id))
      .toEqual({ count: 0 });
  });

  it("samples an unknown-window model with the complete registered native tool set", async () => {
    const root = `${tmpdir()}/socrates-context-tools-${crypto.randomUUID()}`;
    mkdirSync(root, { recursive: true });
    try {
      const policy = new WorkspacePathPolicy(root);
      const definitions = [
        ...createReadOnlyBuiltins(policy),
        ...createWorkspaceWriteBuiltins(policy),
      ];
      const overhead = estimateNativeContextOverhead("", definitions);
      expect(overhead).toBeGreaterThan(4_096);
      const { session, seen, runner } = setupRecording({
        unknownContextWindow: true,
        contextOverheadTokens: overhead,
      });

      expect((await runner.run({
        sessionId: session.id,
        runtimeKind: "recording",
        clientTurnKey: "unknown-window-tools",
        prompt: "hello",
      })).status).toBe("completed");
      expect(seen).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("continues to enforce a known context-window limit", async () => {
    const { db, session, seen, runner } = setupRecording({ contextOverheadTokens: 5_061 });
    setContextWindow(db, session.id, 4_096);

    expect(await runner.run({
      sessionId: session.id,
      runtimeKind: "recording",
      clientTurnKey: "known-small-window",
      prompt: "hello",
    })).toMatchObject({
      status: "failed",
      error: "context_current_unit_exceeds_budget",
    });
    expect(seen).toHaveLength(0);
  });

  it("reloads the complete same-Thread transcript for the second Turn", async () => {
    const { db, session, seen, runner } = setupRecording();
    expect((await runner.run({
      sessionId: session.id,
      runtimeKind: "recording",
      clientTurnKey: "turn-1",
      prompt: "My code is cobalt.",
    })).status).toBe("completed");
    expect((await runner.run({
      sessionId: session.id,
      runtimeKind: "recording",
      clientTurnKey: "turn-2",
      prompt: "What was my code?",
    })).status).toBe("completed");

    expect(seen).toHaveLength(2);
    expect(seen[1]!.map(({ role, content }) => [role, content])).toEqual([
      ["user", "My code is cobalt."],
      ["assistant", "answer-1"],
      ["user", "What was my code?"],
    ]);
    expect(db.query("SELECT COUNT(*) AS count FROM session_messages WHERE role = 'assistant' AND kind = 'text'").get())
      .toEqual({ count: 2 });
  });

  it("continues a local Thread after the database and runner are reopened", async () => {
    const path = `${tmpdir()}/socrates-memory-${crypto.randomUUID()}.db`;
    const seen: RuntimeConversationMessage[][] = [];
    const first = setupRecording({ dbPath: path, seen, response: "first answer" });
    const sessionId = first.session.id;
    await first.runner.run({
      sessionId,
      runtimeKind: "recording",
      clientTurnKey: "before-restart",
      prompt: "Remember amber.",
    });
    first.db.close();

    const second = setupRecording({ dbPath: path, seen, response: "second answer" });
    await second.runner.run({
      sessionId,
      runtimeKind: "recording",
      clientTurnKey: "after-restart",
      prompt: "What should you remember?",
    });
    expect(seen[1]!.map((message) => message.content)).toEqual([
      "Remember amber.",
      "first answer",
      "What should you remember?",
    ]);
    second.db.close();
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  });

  it("keeps a new Thread isolated from the Room default Thread", async () => {
    const { db, session, seen, runner } = setupRecording();
    await runner.run({
      sessionId: session.id,
      runtimeKind: "recording",
      clientTurnKey: "default-turn",
      prompt: "default secret",
    });
    const alternate = new ConversationMemoryStore(db).createThread(session.id);
    await runner.run({
      sessionId: session.id,
      threadId: alternate.id,
      runtimeKind: "recording",
      clientTurnKey: "alternate-turn",
      prompt: "alternate question",
    });
    expect(seen[1]!.map((message) => message.content)).toEqual(["alternate question"]);
  });

  it("keeps different Rooms from inheriting each other's transcript", async () => {
    const { db, seen, runner } = setupRecording();
    const sessions = new SessionStore(db);
    const [firstRoom] = sessions.list();
    const secondRoom = sessions.create({
      title: "Other room",
      mode: "single_agent",
      workspaceId: "w",
      primaryAgentId: "a",
      agents: [{ agentId: "a", snapshot: { nickname: "A" }, executionEligible: true }],
    });
    await runner.run({
      sessionId: firstRoom!.id,
      runtimeKind: "recording",
      clientTurnKey: "room-one",
      prompt: "room one secret",
    });
    await runner.run({
      sessionId: secondRoom.id,
      runtimeKind: "recording",
      clientTurnKey: "room-two",
      prompt: "room two question",
    });
    expect(seen[1]!.map((message) => message.content)).toEqual(["room two question"]);
  });

  it("persists tool call and result so the next model sample receives both", async () => {
    const { session, seen, runner } = setupRecording({ withTool: true, response: "tool answer" });
    await runner.run({
      sessionId: session.id,
      runtimeKind: "recording",
      clientTurnKey: "tool-turn",
      prompt: "read it",
    });
    await runner.run({
      sessionId: session.id,
      runtimeKind: "recording",
      clientTurnKey: "follow-up",
      prompt: "what did the tool return?",
    });
    const followUp = seen[1]!;
    expect(followUp.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "tool",
      "assistant",
      "user",
    ]);
    expect(followUp[1]?.content).toBe("checking first");
    expect(followUp[4]?.content).toBe("tool answer");
    expect(followUp.find((message) => message.role === "tool")?.parts[0]).toMatchObject({
      type: "tool_result",
      callId: "read-call",
      output: { preview: "stored result" },
    });
  });

  it("resolves local text attachments and workspace refs before budgeting without changing durable content", async () => {
    const workspaceRoot = `${tmpdir()}/socrates-memory-workspace-${crypto.randomUUID()}`;
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(`${workspaceRoot}/note.txt`, "workspace-ref-content");
    const { db, session, seen, runner, attachments, attachmentRoot } = setupRecording();
    db.query("UPDATE workspaces SET canonical_path = ?, display_path = ? WHERE id = 'w'")
      .run(workspaceRoot, workspaceRoot);
    const attachment = attachments.importClipboardBytes(
      "w",
      "context.txt",
      Buffer.from("attachment-content"),
    );
    const refBytes = Buffer.from("workspace-ref-content");
    db.query(`
      INSERT INTO workspace_refs
        (id, workspace_id, relative_path, kind, snapshot_hash, snapshot_size, created_at)
      VALUES ('ref', 'w', 'note.txt', 'file', ?, ?, 'now')
    `).run(createHash("sha256").update(refBytes).digest("hex"), refBytes.byteLength);

    try {
      expect((await runner.run({
        sessionId: session.id,
        runtimeKind: "recording",
        clientTurnKey: "local-context",
        prompt: "inspect local context",
        attachmentIds: [attachment.id],
        workspaceRefIds: ["ref"],
      })).status).toBe("completed");
      const sampled = seen[0]![0]!;
      expect(sampled.content).toContain("attachment-content");
      expect(sampled.content).toContain("workspace-ref-content");
      expect(db.query("SELECT content FROM session_messages WHERE role = 'user'").get())
        .toEqual({ content: "inspect local context" });
      expect(db.query<{ metadata_json: string }, []>(`
        SELECT metadata_json FROM message_parts WHERE type = 'workspace_ref'
      `).get()?.metadata_json).toContain("attachmentId");

      writeFileSync(`${workspaceRoot}/note.txt`, "mutated-live-file");
      const mutated = Buffer.from("mutated-live-file");
      db.query("UPDATE workspace_refs SET snapshot_hash = ?, snapshot_size = ? WHERE id = 'ref'")
        .run(createHash("sha256").update(mutated).digest("hex"), mutated.byteLength);
      expect((await runner.run({
        sessionId: session.id,
        runtimeKind: "recording",
        clientTurnKey: "local-context-follow-up",
        prompt: "what did the original file say?",
      })).status).toBe("completed");
      const followUpContext = seen[1]!.map((message) => message.content).join("\n");
      expect(followUpContext).toContain("workspace-ref-content");
      expect(followUpContext).not.toContain("mutated-live-file");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(attachmentRoot, { recursive: true, force: true });
    }
  });

  it("counts resolved attachment contents and refuses an over-budget provider call", async () => {
    const { db, session, seen, runner, attachments, attachmentRoot } = setupRecording();
    setContextWindow(db, session.id, 1_024);
    const attachment = attachments.importClipboardBytes(
      "w",
      "large.txt",
      Buffer.from("local context ".repeat(2_000)),
    );
    try {
      const result = await runner.run({
        sessionId: session.id,
        runtimeKind: "recording",
        clientTurnKey: "large-local-context",
        prompt: "inspect",
        attachmentIds: [attachment.id],
      });
      expect(result).toMatchObject({
        status: "failed",
        error: "context_current_unit_exceeds_budget",
      });
      expect(seen).toHaveLength(0);
    } finally {
      rmSync(attachmentRoot, { recursive: true, force: true });
    }
  });

  it("replays a completed client command without another provider call or duplicate messages", async () => {
    const { db, session, seen, runner } = setupRecording({ response: "once" });
    const input = {
      sessionId: session.id,
      runtimeKind: "recording",
      clientTurnKey: "same-command",
      prompt: "only once",
    };
    const first = await runner.run(input);
    const replay = await runner.run(input);
    expect(replay).toMatchObject({ id: first.id, turnId: first.turnId, status: "completed" });
    expect(seen).toHaveLength(1);
    expect(db.query("SELECT COUNT(*) AS count FROM session_messages").get()).toEqual({ count: 2 });
  });

  it("retries a failed Turn without writing the user message twice", async () => {
    const { db, session } = setupRecording();
    const attempts = { count: 0 };
    const approvals = new ApprovalManager(db);
    const events = new ExecutionEventStore(db);
    const runtimes = new RuntimeManager(db, events);
    runtimes.register("flaky", () => new FlakyRuntime(attempts));
    const runner = new SingleAgentRunner(
      db,
      runtimes,
      approvals,
      events,
      new AttachmentResolver(db, `${tmpdir()}/unused-${crypto.randomUUID()}`),
    );
    const input = {
      sessionId: session.id,
      runtimeKind: "flaky",
      clientTurnKey: "retry-key",
      prompt: "retry me",
    };
    expect((await runner.run(input)).status).toBe("failed");
    expect((await runner.run(input)).status).toBe("completed");
    expect(db.query("SELECT COUNT(*) AS count FROM session_messages WHERE role = 'user'").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM agent_runs").get()).toEqual({ count: 2 });
    expect(db.query("SELECT attempt_no, status FROM conversation_turns").get()).toEqual({
      attempt_no: 2,
      status: "completed",
    });
  });

  it("uses the persisted primary Agent rather than member order", async () => {
    const { db, session, runner } = setupRecording({ response: "from primary" });
    db.query(`
      INSERT INTO session_agents
        (session_id, agent_id, snapshot_json, position, execution_eligible)
      VALUES (?, 'b', '{"nickname":"B"}', 1, 1)
    `).run(session.id);
    db.query("UPDATE sessions SET primary_agent_id = 'b' WHERE id = ?").run(session.id);
    await runner.run({
      sessionId: session.id,
      runtimeKind: "recording",
      clientTurnKey: "primary-agent",
      prompt: "who runs?",
    });
    expect(db.query("SELECT agent_id FROM session_messages WHERE kind = 'text' AND role = 'assistant'").get())
      .toEqual({ agent_id: "b" });
  });

  it("records deterministic context truncation diagnostics at the token limit", async () => {
    const { db, session, runner } = setupRecording({ response: "old answer ".repeat(600) });
    await runner.run({
      sessionId: session.id,
      runtimeKind: "recording",
      clientTurnKey: "large-history",
      prompt: "old question ".repeat(600),
    });
    setContextWindow(db, session.id, 1_024);
    await runner.run({
      sessionId: session.id,
      runtimeKind: "recording",
      clientTurnKey: "limited-context",
      prompt: "current question",
    });
    const turn = db.query<{ context_truncated: number; context_json: string }, []>(`
      SELECT context_truncated, context_json
      FROM conversation_turns
      WHERE client_turn_key = 'limited-context'
    `).get();
    expect(turn?.context_truncated).toBe(1);
    expect(JSON.parse(turn!.context_json)).toMatchObject({
      budgetTokens: 768,
      droppedThroughSequence: 2,
    });
    expect(db.query("SELECT COUNT(*) AS count FROM runtime_events WHERE type = 'context.truncated'").get())
      .toEqual({ count: 1 });
  });

  it("fails before provider sampling when the current work alone exceeds the context budget", async () => {
    const { db, session, seen, runner } = setupRecording({ response: "must not run" });
    setContextWindow(db, session.id, 1_024);
    const result = await runner.run({
      sessionId: session.id,
      runtimeKind: "recording",
      clientTurnKey: "oversized-current",
      prompt: "oversized ".repeat(1_000),
      runtimeOptions: { contextWindowTokens: 4_000_000 },
    });
    expect(result).toMatchObject({
      status: "failed",
      error: "context_current_unit_exceeds_budget",
    });
    expect(seen).toHaveLength(0);
    expect(db.query("SELECT context_truncated, status FROM conversation_turns").get()).toEqual({
      context_truncated: 1,
      status: "failed",
    });
  });

  it("rolls back the final assistant message when terminal Turn persistence fails", async () => {
    const { db, session, runner } = setupRecording({ response: "must roll back" });
    db.exec(`
      CREATE TRIGGER reject_turn_completion
      BEFORE UPDATE ON conversation_turns
      WHEN NEW.status = 'completed'
      BEGIN
        SELECT RAISE(ABORT, 'turn completion rejected');
      END
    `);
    const result = await runner.run({
      sessionId: session.id,
      runtimeKind: "recording",
      clientTurnKey: "atomic-final",
      prompt: "finish atomically",
    });
    expect(result).toMatchObject({ status: "failed", error: "turn completion rejected" });
    expect(db.query("SELECT content, status FROM session_messages WHERE role = 'assistant'").get())
      .toEqual({ content: "must roll back", status: "failed" });
    expect(db.query("SELECT COUNT(*) AS count FROM session_messages WHERE role = 'assistant' AND status = 'completed'").get())
      .toEqual({ count: 0 });
    expect(db.query("SELECT status FROM conversation_turns").get()).toEqual({ status: "failed" });
    expect(db.query("SELECT status FROM agent_runs").get()).toEqual({ status: "failed" });
  });

  it("does not depend on PATH, CODEX_HOME, or a local Codex executable", async () => {
    const originalPath = process.env.PATH;
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.PATH = "";
    process.env.CODEX_HOME = `/nonexistent/${crypto.randomUUID()}`;
    try {
      const { session, runner } = setupRecording({ response: "native" });
      expect((await runner.run({
        sessionId: session.id,
        runtimeKind: "recording",
        clientTurnKey: "no-codex",
        prompt: "continue",
      })).status).toBe("completed");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
    }
  });

  it("rolls back run preparation when a message part cannot be persisted", async () => {
    const { db, session, runner } = setup();
    db.exec(`CREATE TRIGGER reject_message_part
      BEFORE INSERT ON message_parts
      BEGIN
        SELECT RAISE(ABORT, 'message part rejected');
      END`);

    await expect(runner.run({ sessionId: session.id, runtimeKind: "fake", prompt: "do it" })).rejects.toThrow("message part rejected");
    expect(db.query("SELECT COUNT(*) AS count FROM agent_runs").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM session_messages").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM runtime_events").get()).toEqual({ count: 0 });
    expect(db.query("SELECT status FROM sessions WHERE id = ?").get(session.id)).toEqual({ status: "idle" });
  });

  it("pauses at durable exact approval and resumes once", async () => {
    const { db, session, approvals, runner } = setup();
    const emitted: RuntimeEvent[] = [];
    let resolveApproval!: () => void;
    const approvalReady = new Promise<void>((resolve) => { resolveApproval = resolve; });
    const runPromise = runner.run({ sessionId: session.id, runtimeKind: "fake", prompt: "do it" }, async (event) => {
      emitted.push(event);
      if (event.type === "approval_required") resolveApproval();
    });
    await approvalReady;
    const pending = approvals.recoverPending().pending[0]!;
    expect(pending.inputHash).toHaveLength(64);
    const replay = new ExecutionEventStore(db).listAfter(pending.taskId, 0);
    const replayedApprovals = replay
      .map(executionEventToRuntimeEvent)
      .filter((event) => event?.type === "approval_required");
    expect(replayedApprovals).toEqual([{
      type: "approval_required",
      requestId: pending.id,
      callId: "call",
      kind: "command_execution",
      policyVersion: 1,
      risk: "medium",
      freshHumanRequired: false,
    }]);
    await runner.decide(pending.id, { clientDecisionKey: "decision", decision: "allow_once" });
    const result = await runPromise;
    expect(result.status).toBe("completed");
    expect(emitted.some((event) => event.type === "text_delta" && event.text === "done")).toBe(true);
    expect(db.query("SELECT content FROM session_messages WHERE role = 'assistant' AND kind = 'text'").get()).toEqual({ content: "done" });
    expect(db.query("SELECT text FROM message_parts JOIN session_messages ON session_messages.id = message_parts.message_id WHERE session_messages.role = 'assistant' AND session_messages.kind = 'text'").get()).toEqual({ text: "done" });
    expect(db.query("SELECT status FROM runtime_sessions").get()).toEqual({ status: "closed" });
    await expect(runner.decide(pending.id, { clientDecisionKey: "again", decision: "allow_once" })).rejects.toThrow("approval_already_decided");
  });

  it("retries approval delivery without duplicating its durable decision event", async () => {
    const { db, session, approvals } = setup();
    const events = new ExecutionEventStore(db);
    const runtimes = new RuntimeManager(db, events);
    const runtime = new FlakyApprovalDeliveryRuntime();
    runtimes.register("flaky-approval", () => runtime);
    const runner = new SingleAgentRunner(
      db, runtimes, approvals, events,
      new AttachmentResolver(db, `${tmpdir()}/unused-${crypto.randomUUID()}`),
    );
    let approvalReady!: () => void;
    const ready = new Promise<void>((resolve) => { approvalReady = resolve; });
    const running = runner.run({
      sessionId: session.id, runtimeKind: "flaky-approval", prompt: "approve",
    }, (event) => {
      if (event.type === "approval_required") approvalReady();
    });
    await ready;
    const request = approvals.recoverPending().pending[0]!;
    const input = { clientDecisionKey: "stable-delivery", decision: "allow_once" as const };
    await expect(runner.decide(request.id, input)).rejects.toThrow("approval_delivery_failed");
    expect(db.query("SELECT COUNT(*) AS count FROM runtime_events WHERE type = 'approval.decided'").get())
      .toEqual({ count: 1 });
    await runner.decide(request.id, input);
    expect((await running).status).toBe("completed");
    expect(runtime.attempts).toBe(2);
    expect(db.query("SELECT COUNT(*) AS count FROM runtime_events WHERE type = 'approval.decided'").get())
      .toEqual({ count: 1 });
  });

  it("repairs a failed approval-request append before writing the terminal event", async () => {
    const { db, session, approvals } = setup();
    const events = new ExecutionEventStore(db);
    const append = events.append.bind(events);
    let failRequest = true;
    events.append = ((input, project) => {
      if (failRequest && input.type === "approval.requested") {
        failRequest = false;
        throw new Error("approval_journal_failed");
      }
      return append(input, project);
    }) as typeof events.append;
    const runtimes = new RuntimeManager(db, events);
    runtimes.register("approval-gap", () => new ApprovalRuntime());
    const runner = new SingleAgentRunner(
      db, runtimes, approvals, events,
      new AttachmentResolver(db, `${tmpdir()}/unused-${crypto.randomUUID()}`),
    );

    await expect(runner.run({
      sessionId: session.id, runtimeKind: "approval-gap", prompt: "approve",
    })).rejects.toThrow("approval_journal_failed");

    const lifecycle = db.query<{ type: string; seq: number }, []>(`
      SELECT type, seq FROM runtime_events ORDER BY seq
    `).all();
    const request = lifecycle.find((event) => event.type === "approval.requested")!;
    const terminal = lifecycle.find((event) => event.type === "run.failed")!;
    expect(request.seq).toBeLessThan(terminal.seq);
    expect(lifecycle.at(-1)?.type).toBe("run.failed");
    expect(approvals.recoverPending().pending).toEqual([]);
  });

  it("repairs a failed approval-decision append before cancellation can continue", async () => {
    const { db, session, approvals } = setup();
    const events = new ExecutionEventStore(db);
    const append = events.append.bind(events);
    let failDecision = true;
    events.append = ((input, project) => {
      if (failDecision && input.type === "approval.decided") {
        failDecision = false;
        throw new Error("decision_journal_failed");
      }
      return append(input, project);
    }) as typeof events.append;
    const runtimes = new RuntimeManager(db, events);
    runtimes.register("cancellable-approval", () => new CancellableApprovalRuntime());
    const runner = new SingleAgentRunner(
      db, runtimes, approvals, events,
      new AttachmentResolver(db, `${tmpdir()}/unused-${crypto.randomUUID()}`),
    );
    let runId = "";
    let approvalReady!: () => void;
    const ready = new Promise<void>((resolve) => { approvalReady = resolve; });
    const running = runner.run({
      sessionId: session.id, runtimeKind: "cancellable-approval", prompt: "approve",
    }, (event) => {
      if (event.type === "extension" && event.name === "run_started") {
        runId = String((event.payload as { runId: unknown }).runId);
      }
      if (event.type === "approval_required") approvalReady();
    });
    await ready;
    const request = approvals.recoverPending().pending[0]!;
    await expect(runner.decide(request.id, {
      clientDecisionKey: "failed-decision-event", decision: "allow_once",
    })).rejects.toThrow("decision_journal_failed");
    await runner.cancel(runId);
    expect((await running).status).toBe("cancelled");

    const types = db.query<{ type: string }, [string]>(`
      SELECT type FROM runtime_events WHERE run_id = ? ORDER BY seq
    `).all(runId).map(({ type }) => type);
    expect(types.indexOf("approval.decided")).toBeLessThan(types.indexOf("run.cancel_requested"));
    expect(types.indexOf("run.cancel_requested")).toBeLessThan(types.indexOf("run.cancelled"));
  });

  it("keeps terminal events blocked while approval-decision reconciliation is unavailable", async () => {
    const { db, session, approvals } = setup();
    const events = new ExecutionEventStore(db);
    const append = events.append.bind(events);
    let blockDecisions = true;
    events.append = ((input, project) => {
      if (blockDecisions && input.type === "approval.decided") {
        throw new Error("decision_journal_unavailable");
      }
      return append(input, project);
    }) as typeof events.append;
    const runtimes = new RuntimeManager(db, events);
    runtimes.register("blocked-approval", () => new CancellableApprovalRuntime());
    const runner = new SingleAgentRunner(
      db, runtimes, approvals, events,
      new AttachmentResolver(db, `${tmpdir()}/unused-${crypto.randomUUID()}`),
    );
    const controller = new AbortController();
    let approvalReady!: () => void;
    const ready = new Promise<void>((resolve) => { approvalReady = resolve; });
    const running = runner.run({
      sessionId: session.id,
      runtimeKind: "blocked-approval",
      prompt: "approve",
      signal: controller.signal,
    }, (event) => {
      if (event.type === "approval_required") approvalReady();
    });
    await ready;
    const request = approvals.recoverPending().pending[0]!;
    await expect(runner.decide(request.id, {
      clientDecisionKey: "persistently-blocked-decision", decision: "allow_once",
    })).rejects.toThrow("decision_journal_unavailable");

    controller.abort();
    await expect(running).rejects.toThrow("decision_journal_unavailable");
    expect(db.query("SELECT COUNT(*) AS count FROM runtime_events WHERE type IN ('run.failed', 'run.cancelled')").get())
      .toEqual({ count: 0 });

    blockDecisions = false;
    runner.recoverInterrupted();
    const repaired = db.query<{ type: string }, []>(`
      SELECT type FROM runtime_events
      WHERE type IN ('approval.decided', 'run.cancelled') ORDER BY seq
    `).all().map(({ type }) => type);
    expect(repaired).toEqual(["approval.decided", "run.cancelled"]);
  });

  it("does not rewrite a completed Turn when terminal journaling fails", async () => {
    const { db, session, approvals } = setup();
    const events = new ExecutionEventStore(db);
    const append = events.append.bind(events);
    let failCompletion = true;
    events.append = ((input, project) => {
      if (failCompletion && input.type === "run.completed") {
        failCompletion = false;
        throw new Error("terminal_journal_failed");
      }
      return append(input, project);
    }) as typeof events.append;
    const runtimes = new RuntimeManager(db, events);
    runtimes.register("recording", () => new RecordingRuntime([], "final"));
    const runner = new SingleAgentRunner(
      db, runtimes, approvals, events,
      new AttachmentResolver(db, `${tmpdir()}/unused-${crypto.randomUUID()}`),
    );
    const input = {
      sessionId: session.id,
      runtimeKind: "recording",
      clientTurnKey: "terminal-reconcile",
      prompt: "finish",
    };
    await expect(runner.run(input)).rejects.toThrow("terminal_journal_failed");
    expect(db.query("SELECT status FROM agent_runs").get()).toEqual({ status: "completed" });
    expect(db.query("SELECT content, status FROM session_messages WHERE role = 'assistant'").get())
      .toEqual({ content: "final", status: "completed" });
    expect((await runner.run(input)).status).toBe("completed");
    expect(db.query("SELECT COUNT(*) AS count FROM runtime_events WHERE type = 'run.completed'").get())
      .toEqual({ count: 1 });
  });

  it("persists only an explicit public reasoning summary extension", async () => {
    const { db, session, runner } = setup();
    await runner.run({
      sessionId: session.id,
      runtimeKind: "public-summary",
      prompt: "explain safely",
    }, () => {});

    const assistant = new SessionStore(db).listMessages(session.id)
      .find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("done");
    expect(assistant?.parts).toEqual([
      { type: "reasoning_summary", text: "Checked the public constraints." },
      { type: "text", text: "done" },
    ]);
  });

  it("records an explicit user cancellation as cancelled rather than failed", async () => {
    const { db, session, approvals } = setup();
    const events = new ExecutionEventStore(db);
    const runtimes = new RuntimeManager(db, events);
    runtimes.register("interruptible", () => new InterruptibleRuntime());
    const runner = new SingleAgentRunner(db, runtimes, approvals, events, new AttachmentResolver(db, `${tmpdir()}/unused-${crypto.randomUUID()}`));
    let runId = "";
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const runPromise = runner.run({ sessionId: session.id, runtimeKind: "interruptible", prompt: "wait" }, (event) => {
      if (event.type === "extension" && event.name === "run_started") {
        runId = String((event.payload as { runId: unknown }).runId);
      }
      if (event.type === "status" && event.status === "running") started();
    });
    await startedPromise;
    await runner.cancel(runId);
    expect((await runPromise).status).toBe("cancelled");
    expect(db.query("SELECT status FROM sessions WHERE id = ?").get(session.id)).toEqual({ status: "cancelled" });
    expect(db.query("SELECT COUNT(*) AS count FROM session_messages WHERE role = 'user'").get()).toEqual({ count: 1 });
    expect(db.query("SELECT content, status FROM session_messages WHERE role = 'assistant' AND kind = 'text'").get())
      .toEqual({ content: "confirmed partial", status: "cancelled" });
  });

  it("uses the supervisor signal after a concrete Runtime interrupt fails", async () => {
    const { db, session, approvals } = setup();
    const events = new ExecutionEventStore(db);
    const runtimes = new RuntimeManager(db, events);
    const runtime = new ThrowingInterruptRuntime();
    runtimes.register("throwing-interrupt", () => runtime);
    const runner = new SingleAgentRunner(
      db,
      runtimes,
      approvals,
      events,
      new AttachmentResolver(db, `${tmpdir()}/unused-${crypto.randomUUID()}`),
    );
    const supervisor = new RunSupervisor(runner);
    const started = await supervisor.start({
      sessionId: session.id,
      runtimeKind: "throwing-interrupt",
      prompt: "wait",
    });
    await runtime.started;

    await supervisor.cancel(started.runId);

    let cursor = 0;
    while (!events.listAfter(started.runId, cursor).some((event) => event.type === "run.cancelled")) {
      cursor = events.latestSeq(started.runId);
      await events.waitForAppend(started.runId, cursor);
    }
    expect(runtime.interruptCalls).toBe(1);
    const eventTypes = events.listAfter(started.runId, 0).map((event) => event.type);
    expect(eventTypes.indexOf("run.cancel_requested")).toBeGreaterThan(
      eventTypes.indexOf("run.started"),
    );
    expect(eventTypes.indexOf("run.cancelled")).toBeGreaterThan(
      eventTypes.indexOf("run.cancel_requested"),
    );
  });

  it("recovers a restart by interrupting orphaned runs and expiring their approvals", () => {
    const { db, session, approvals, runner } = setup();
    const now = new Date().toISOString();
    db.query("INSERT INTO agent_runs (id, session_id, prompt, status, created_at) VALUES ('orphan', ?, 'work', 'awaiting_approval', ?)").run(session.id, now);
    db.query(`
      INSERT INTO agent_runs (id, session_id, prompt, status, created_at, completed_at)
      VALUES ('completed-with-gap', ?, 'done', 'completed', ?, ?)
    `).run(session.id, now, now);
    db.query("UPDATE sessions SET primary_agent_id = NULL WHERE id = ?").run(session.id);
    db.query("UPDATE sessions SET status = 'awaiting_approval' WHERE id = ?").run(session.id);
    approvals.request({
      taskId: "orphan", kind: "tool", subjectId: "orphan:call", inputHash: "hash",
      workspaceIdentity: "workspace", attemptId: "orphan", policyVersion: 1, risk: "medium", freshHumanRequired: false,
    });
    const decidedRequest = approvals.request({
      taskId: "completed-with-gap", kind: "tool", subjectId: "completed-with-gap:call",
      inputHash: "decided-hash", workspaceIdentity: "workspace",
      attemptId: "completed-with-gap", policyVersion: 1, risk: "medium", freshHumanRequired: false,
    });
    approvals.decide(decidedRequest.id, {
      clientDecisionKey: "recovered-decision", decision: "allow_once",
    });
    db.query(`
      INSERT INTO tool_calls
      (id, stable_key, session_id, task_id, attempt_id, turn_id, agent_id, name, generation, input_json, input_hash,
       workspace_identity, policy_version, risk, idempotency, status, created_at, updated_at)
      VALUES ('old-call', 'old-stable', ?, 'agent-session-id', 'orphan', 'turn', 'agent', 'run_shell', 1, '{}', 'hash',
       'workspace', 1, 'destructive', 'non_idempotent', 'awaiting_approval', ?, ?)
    `).run(session.id, now, now);
    expect(runner.recoverInterrupted()).toEqual({ runs: 1, approvals: 1 });
    expect(db.query("SELECT status, error FROM agent_runs WHERE id = 'orphan'").get()).toEqual({ status: "interrupted", error: "sidecar_restarted" });
    expect(db.query<{ type: string }, [string]>(
      "SELECT type FROM runtime_events WHERE run_id = ? ORDER BY seq",
    ).all("orphan").map(({ type }) => type))
      .toEqual(["approval.requested", "run.interrupted"]);
    expect(db.query<{ type: string }, [string]>(
      "SELECT type FROM runtime_events WHERE run_id = ? ORDER BY seq",
    ).all("completed-with-gap").map(({ type }) => type))
      .toEqual(["approval.requested", "approval.decided", "run.completed"]);
    expect(approvals.recoverPending().pending).toEqual([]);
    expect(db.query("SELECT status, error FROM tool_calls WHERE id = 'old-call'").get())
      .toEqual({ status: "cancelled", error: "sidecar_restarted" });
  });

  it("attributes repaired terminal events to the immutable Turn agent", async () => {
    const { db, session, runner } = setupRecording({ response: "done" });
    const result = await runner.run({
      sessionId: session.id, runtimeKind: "recording", prompt: "remember the agent",
    });
    db.query(`
      INSERT INTO session_agents
        (session_id, agent_id, snapshot_json, position, execution_eligible)
      VALUES (?, 'replacement', '{}', 1, 1)
    `).run(session.id);
    db.query("UPDATE sessions SET primary_agent_id = 'replacement' WHERE id = ?").run(session.id);
    db.query("DELETE FROM runtime_events WHERE run_id = ?").run(result.id);

    runner.recoverInterrupted();

    expect(db.query<{ type: string; agent_id: string }, [string]>(
      "SELECT type, agent_id FROM runtime_events WHERE run_id = ? ORDER BY seq",
    ).all(result.id)).toEqual([
      { type: "run.created", agent_id: "a" },
      { type: "run.completed", agent_id: "a" },
    ]);
  });
});
