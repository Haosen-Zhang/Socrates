import { describe, expect, it } from "bun:test";
import type { AgentRuntime, ApprovalDecision, RuntimeEvent } from "@socrates/core";
import { UNKNOWN_MODEL_CAPABILITIES } from "@socrates/core";
import { openDb } from "../db";
import { ApprovalManager } from "../approvals/manager";
import { EventStore } from "../store/event-store";
import { SessionStore } from "../store/session-store";
import { RuntimeManager } from "./runtime-manager";
import { SingleAgentRunner } from "./single-agent-runner";
import { AttachmentResolver } from "../attachments/resolver";
import { tmpdir } from "node:os";

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

class InterruptibleRuntime implements AgentRuntime {
  readonly kind = "interruptible";
  readonly capabilities = { ...UNKNOWN_MODEL_CAPABILITIES, textInput: true as const };
  private reject: ((error: Error) => void) | null = null;
  private interrupted = false;
  async open() {}
  async *start(): AsyncIterable<RuntimeEvent> {
    yield { type: "status", status: "running" };
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

function setup() {
  const db = openDb(":memory:");
  db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("w", "/tmp/w", "/tmp/w", "workspace-hash", "w", "now", "now");
  const session = new SessionStore(db).create({
    title: "Solo", mode: "single_agent", workspaceId: "w",
    agents: [{ agentId: "a", snapshot: { nickname: "A" }, executionEligible: true }],
  });
  const approvals = new ApprovalManager(db);
  const events = new EventStore(db);
  const runtimes = new RuntimeManager(db, events);
  runtimes.register("fake", () => new ApprovalRuntime());
  return { db, session, approvals, runner: new SingleAgentRunner(db, runtimes, approvals, events, new AttachmentResolver(db, `${tmpdir()}/unused-${crypto.randomUUID()}`)) };
}

describe("SingleAgentRunner", () => {
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
    expect(db.query("SELECT COUNT(*) AS count FROM task_events").get()).toEqual({ count: 0 });
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
    await runner.decide(pending.id, { clientDecisionKey: "decision", decision: "allow_once" });
    const result = await runPromise;
    expect(result.status).toBe("completed");
    expect(emitted.some((event) => event.type === "text_delta" && event.text === "done")).toBe(true);
    expect(db.query("SELECT content FROM session_messages WHERE role = 'assistant'").get()).toEqual({ content: "done" });
    expect(db.query("SELECT text FROM message_parts JOIN session_messages ON session_messages.id = message_parts.message_id WHERE session_messages.role = 'assistant'").get()).toEqual({ text: "done" });
    expect(db.query("SELECT status FROM runtime_sessions").get()).toEqual({ status: "closed" });
    await expect(runner.decide(pending.id, { clientDecisionKey: "again", decision: "allow_once" })).rejects.toThrow("approval_already_decided");
  });

  it("records an explicit user cancellation as cancelled rather than failed", async () => {
    const { db, session, approvals } = setup();
    const events = new EventStore(db);
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
  });
});
