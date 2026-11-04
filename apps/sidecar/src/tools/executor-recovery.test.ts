import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StructuredExecutionError, type PermissionEvaluation, type ToolContext, type ToolDefinition } from "@socrates/core";
import { openDb } from "../db";
import { ApprovalManager } from "../approvals/manager";
import { ExecutionEventStore } from "../store/execution-event-store";
import { ToolExecutor } from "./executor";
import { ToolRegistry } from "./registry";
import { ToolExecutionJournal } from "./execution-journal";

const permission: PermissionEvaluation = { effect: "allow", risk: "low", matchedRuleIds: [], reasonCode: "test", freshHumanRequired: false, policyVersion: 1 };
function setup(body: ToolDefinition["execute"], idempotency: ToolDefinition["idempotency"] = "read", dbPath = ":memory:") {
  const db = openDb(dbPath);
  const events = new ExecutionEventStore(db);
  const registry = new ToolRegistry([{
    name: "test_tool", description: "test", inputSchema: { type: "object", properties: {} },
    risk: "low", idempotency, capability: idempotency === "read" ? "workspace_read" : "workspace_write", generation: 1, execute: body,
  }]);
  const context: ToolContext & { stepId: string } = {
    callId: "call", sessionId: "session", taskId: "run", turnId: "turn", stepId: "step", agentId: "agent",
    mode: "single_agent", phase: "executing", signal: new AbortController().signal,
  };
  const request = { stableKey: "key", name: "test_tool", generation: 1, input: {}, workspaceIdentity: "workspace", policyVersion: 1 };
  const executor = new ToolExecutor(db, registry, new ApprovalManager(db));
  return { db, events, context, request, executor };
}

describe("durable ToolExecutor", () => {
  it("recovers after reopening SQLite and expires an allowed but undispatched approval", async () => {
    const root = mkdtempSync(join(tmpdir(), "socrates-tool-restart-"));
    const path = join(root, "test.db");
    let effects = 0;
    const s = setup(async () => { effects++; return "done"; }, "non_idempotent", path);
    try {
      const pending = await s.executor.invoke(s.request, s.context, { ...permission, effect: "ask" });
      new ApprovalManager(s.db).decide(pending.approval!.id, { clientDecisionKey: "approve", decision: "allow_once" });
      s.db.close();
      const reopened = openDb(path);
      try {
        expect(new ToolExecutionJournal(reopened).recoverInterrupted()).toBe(1);
        expect(reopened.query("SELECT status FROM approval_requests").get()).toEqual({ status: "expired" });
        expect(reopened.query<{ preview_text: string }, []>("SELECT preview_text FROM tool_outputs").get()!.preview_text).toContain("TOOL_NOT_STARTED");
        expect(new ToolExecutionJournal(reopened).recoverInterrupted()).toBe(0);
        expect(effects).toBe(0);
      } finally { reopened.close(); }
    } finally { s.db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("treats an unserializable result as a fatal checkpoint failure after one effect", async () => {
    let effects = 0;
    const s = setup(async () => { effects++; return { value: 1n }; }, "non_idempotent");
    await expect(s.executor.invoke(s.request, s.context, permission)).rejects.toMatchObject({
      detail: { code: "TOOL_RESULT_SERIALIZATION_FAILED", category: "persistence", retryable: false },
    });
    expect(effects).toBe(1);
    expect(s.db.query("SELECT status FROM tool_calls").get()).toEqual({ status: "running" });
  });

  it("rejects replay and approval delivery across execution scopes", async () => {
    const s = setup(async () => "done");
    await s.executor.invoke(s.request, s.context, permission);
    await expect(s.executor.invoke(s.request, { ...s.context, taskId: "other-run" }, permission))
      .rejects.toThrow("tool_call_scope_mismatch");
    await expect(s.executor.invoke({ ...s.request, workspaceIdentity: "other-workspace" }, s.context, permission))
      .rejects.toThrow("tool_call_scope_mismatch");
  });

  it("does not retry semantic errors even when incorrectly marked retryable", async () => {
    let effects = 0;
    const s = setup(async () => {
      effects++;
      throw new StructuredExecutionError({ code: "ENOENT", category: "filesystem", phase: "tool_execution", retryable: true, message: "missing" });
    });
    await s.executor.invoke(s.request, s.context, permission);
    expect(effects).toBe(1);
  });

  it("classifies crash outcomes without repeating bodies and preserves committed success", async () => {
    for (const [idempotency, disposition] of [["read", "safe_to_retry"], ["non_idempotent", "verify_then_continue"]] as const) {
      let effects = 0;
      const s = setup(async () => { effects++; return "done"; }, idempotency);
      s.db.exec(`CREATE TRIGGER fail_result BEFORE INSERT ON tool_outputs BEGIN SELECT RAISE(ABORT, 'disk_full'); END`);
      await expect(s.executor.invoke(s.request, s.context, permission)).rejects.toThrow("disk_full");
      s.db.exec("DROP TRIGGER fail_result");
      const journal = new ToolExecutionJournal(s.db, s.events);
      expect(journal.recoverInterrupted()).toBe(1);
      expect(journal.recoverInterrupted()).toBe(0);
      const replay = await s.executor.invoke(s.request, s.context, permission);
      expect(replay.status).toBe("outcome_unknown");
      expect(JSON.parse(replay.output!.preview)).toMatchObject({ code: "TOOL_OUTCOME_UNKNOWN", disposition });
      expect(effects).toBe(1);
      expect(s.events.listAfter("run", 0).at(-1)?.type).toBe("tool.outcome_unknown");
    }
    const s = setup(async () => "done");
    await s.executor.invoke(s.request, s.context, permission);
    expect(new ToolExecutionJournal(s.db).recoverInterrupted()).toBe(0);
    expect((await s.executor.invoke(s.request, s.context, permission)).output?.preview).toBe("done");
  });

  it("does not start a second body while duplicate approved deliveries overlap", async () => {
    let effects = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const s = setup(async () => { effects++; await pending; return "done"; });
    const first = s.executor.invoke(s.request, s.context, permission);
    const duplicate = s.executor.invoke(s.request, s.context, permission);
    release();
    await Promise.all([first, duplicate]);
    expect(effects).toBe(1);
  });
  it("commits logical intent and an attempt before entering the tool body", async () => {
    let before: string[] = [];
    const s = setup(async () => {
      before = s.events.listAfter("run", 0).map((event) => event.type);
      return "done";
    });
    await s.executor.invoke(s.request, s.context, permission);
    expect(before).toEqual(["tool.operation.requested", "tool.attempt.checkpointed", "tool.attempt.started"]);
    expect(s.events.listAfter("run", 0).at(-1)?.type).toBe("tool.attempt.result");
  });

  it("does not enter the body when the execution journal checkpoint fails", async () => {
    let effects = 0;
    const s = setup(async () => { effects++; return "done"; }, "non_idempotent");
    s.db.exec(`CREATE TRIGGER fail_checkpoint BEFORE INSERT ON runtime_events
      WHEN NEW.type = 'tool.attempt.started' BEGIN SELECT RAISE(ABORT, 'checkpoint_failed'); END`);
    await expect(s.executor.invoke(s.request, s.context, permission)).rejects.toThrow("checkpoint_failed");
    expect(effects).toBe(0);
  });

  it("leaves a started operation uncertain when result persistence fails after an effect", async () => {
    let effects = 0;
    const s = setup(async () => { effects++; return "done"; }, "non_idempotent");
    s.db.exec(`CREATE TRIGGER fail_result BEFORE INSERT ON tool_outputs BEGIN SELECT RAISE(ABORT, 'result_failed'); END`);
    await expect(s.executor.invoke(s.request, s.context, permission)).rejects.toThrow("result_failed");
    expect(effects).toBe(1);
    expect(s.db.query("SELECT status FROM tool_calls").get()).toEqual({ status: "running" });
    expect(s.events.listAfter("run", 0).some((event) => event.type === "tool.attempt.result")).toBe(false);
  });

  it("retries a transient read in separate attempts but not a mutation or missing file", async () => {
    for (const [idempotency, code, expected] of [["read", "ECONNRESET", 3], ["non_idempotent", "ECONNRESET", 1], ["read", "ENOENT", 1]] as const) {
      let effects = 0;
      const s = setup(async () => { effects++; throw Object.assign(new Error(code), { code }); }, idempotency);
      await s.executor.invoke(s.request, s.context, permission);
      expect(effects).toBe(expected);
      const attempts = s.db.query<{ id: string }, []>("SELECT id FROM tool_attempts").all();
      expect(new Set(attempts.map((attempt) => attempt.id)).size).toBe(expected);
    }
  });
});
