import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PermissionEvaluation, ToolContext, ToolDefinition } from "@socrates/core";
import { openDb } from "../db";
import { ApprovalManager } from "../approvals/manager";
import { ExecutionEventStore } from "../store/execution-event-store";
import { WorkspaceManager } from "../workspace/manager";
import { WorkspacePathPolicy } from "../workspace/path-policy";
import { ToolExecutor } from "./executor";
import { ToolExecutionJournal } from "./execution-journal";
import { ToolRegistry } from "./registry";

const allow: PermissionEvaluation = { effect: "allow", risk: "high", matchedRuleIds: [], reasonCode: "test", freshHumanRequired: false, policyVersion: 1 };

describe("journal workspace evidence recovery", () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "socrates-journal-workspace-")); mkdirSync(join(directory, "workspace")); });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function setup(body?: ToolDefinition["execute"], config: { name?: string; input?: unknown } = {}) {
    const dbPath = join(directory, "state.sqlite");
    const db = openDb(dbPath);
    const workspace = new WorkspaceManager(db).select(join(directory, "workspace"));
    const policy = new WorkspacePathPolicy(workspace.canonicalPath);
    let bodies = 0;
    const tool: ToolDefinition = {
      name: config.name ?? "write_file", description: "write", inputSchema: { type: "object" }, generation: 1,
      risk: "high", idempotency: "non_idempotent", capability: "workspace_write",
      execute: async (input, context) => {
        bodies++;
        if (body) return body(input, context);
        const { path, content } = input as { path: string; content: string };
        return policy.writeText(path, content, { operationId: context.callId });
      },
    };
    const registry = new ToolRegistry([tool]);
    const approvals = new ApprovalManager(db);
    const executor = new ToolExecutor(db, registry, approvals);
    const context: ToolContext = { callId: "write-operation", sessionId: "session", taskId: "run", turnId: "turn", stepId: "step", agentId: "agent", mode: "single_agent", phase: "executing", signal: new AbortController().signal };
    const request = { stableKey: "write-key", name: tool.name, generation: 1, input: config.input ?? { path: "./a.txt", content: "complete" }, workspaceIdentity: workspace.identityHash, policyVersion: 1 };
    db.exec(`CREATE TRIGGER lose_result BEFORE INSERT ON runtime_events WHEN NEW.type = 'tool.attempt.result'
      BEGIN SELECT RAISE(ABORT, 'result_event_failed'); END`);
    return { db, dbPath, workspace, policy, registry, approvals, executor, context, request, bodies: () => bodies };
  }

  it("recovers a verified write after result-event failure and SQLite reopen exactly once", async () => {
    const s = setup();
    const pending = await s.executor.invoke(s.request, s.context, { ...allow, effect: "ask" });
    s.approvals.decide(pending.approval!.id, { clientDecisionKey: "approve-write", decision: "allow_once" });
    await expect(s.executor.resumeApproved(s.context.callId, s.context)).rejects.toThrow("result_event_failed");
    const inode = statSync(join(s.workspace.canonicalPath, "a.txt")).ino;
    expect(s.bodies()).toBe(1);
    expect(s.db.query("SELECT status FROM tool_calls").get()).toEqual({ status: "running" });
    s.db.exec("DROP TRIGGER lose_result"); s.db.close();
    const reopened = openDb(s.dbPath);
    try {
      const journal = new ToolExecutionJournal(reopened);
      expect(journal.recoverInterrupted()).toBe(1);
      expect(reopened.query("SELECT status, recovery_disposition FROM tool_calls").get()).toEqual({ status: "succeeded", recovery_disposition: "verify_then_continue" });
      const output = reopened.query<{ canonical_json: string; is_error: number }, []>("SELECT canonical_json, is_error FROM tool_outputs").get()!;
      expect(output.is_error).toBe(0);
      expect(JSON.parse(output.canonical_json)).toMatchObject({ code: "TOOL_RECOVERED_APPLIED", recovery: { outcome: "applied", evidence: { kind: "write", path: "a.txt" } } });
      expect(reopened.query("SELECT status FROM approval_requests").get()).toEqual({ status: "expired" });
      expect(new ExecutionEventStore(reopened).listAfter("run", 0).at(-1)).toMatchObject({ type: "tool.attempt.result", payload: { status: "succeeded", isError: false } });
      expect(journal.recoverInterrupted()).toBe(0);
      const replay = await new ToolExecutor(reopened, s.registry, new ApprovalManager(reopened)).invoke(s.request, s.context, allow);
      expect(replay.status).toBe("succeeded");
      expect(s.bodies()).toBe(1);
      expect(statSync(join(s.workspace.canonicalPath, "a.txt")).ino).toBe(inode);
      expect(readFileSync(join(s.workspace.canonicalPath, "a.txt"), "utf8")).toBe("complete");
    } finally { reopened.close(); }
  });

  it("requires confirmation if external edits diverged from durable write evidence", async () => {
    const s = setup();
    try {
      await expect(s.executor.invoke(s.request, s.context, allow)).rejects.toThrow("result_event_failed");
      writeFileSync(join(s.workspace.canonicalPath, "a.txt"), "user edit");
      s.db.exec("DROP TRIGGER lose_result");
      new ToolExecutionJournal(s.db).recoverInterrupted();
      expect(s.db.query("SELECT status, recovery_disposition FROM tool_calls").get()).toEqual({ status: "outcome_unknown", recovery_disposition: "requires_user_confirmation" });
      const output = s.db.query<{ preview_text: string }, []>("SELECT preview_text FROM tool_outputs").get()!;
      expect(JSON.parse(output.preview_text)).toMatchObject({ code: "TOOL_OUTCOME_UNKNOWN", recovery: { outcome: "unknown" } });
      expect(readFileSync(join(s.workspace.canonicalPath, "a.txt"), "utf8")).toBe("user edit");
      expect(s.bodies()).toBe(1);
    } finally { s.db.close(); }
  });

  it("binds recovery to persisted write content rather than just operation and path", async () => {
    const s = setup(async (_input, context) => new WorkspacePathPolicy(join(directory, "workspace")).writeText("a.txt", "different content", { operationId: context.callId }));
    try {
      await expect(s.executor.invoke(s.request, s.context, allow)).rejects.toThrow("result_event_failed");
      s.db.exec("DROP TRIGGER lose_result");
      new ToolExecutionJournal(s.db).recoverInterrupted();
      expect(s.db.query("SELECT status, recovery_disposition FROM tool_calls").get()).toEqual({ status: "outcome_unknown", recovery_disposition: "recovery_blocked" });
      expect(s.bodies()).toBe(1);
    } finally { s.db.close(); }
  });
  it("recovers a genuine subprocess death while staging as not applied without replay", async () => {
    let crashExit = -1;
    const s = setup(async (_input, context) => {
      const script = `
        import { mock } from "bun:test";
        import * as fs from "node:fs";
        const sync = fs.fsyncSync;
        mock.module("node:fs", () => ({ ...fs, fsyncSync(fd) {
          sync(fd);
          const stat = fs.fstatSync(fd);
          if (stat.isFile() && stat.size === 8) process.exit(79);
        }}));
        const { WorkspacePathPolicy } = await import(${JSON.stringify(new URL("../workspace/path-policy.ts", import.meta.url).pathname)});
        new WorkspacePathPolicy(process.argv[1]).writeText("a.txt", "complete", { operationId: process.argv[2] });
      `;
      crashExit = Bun.spawnSync([process.execPath, "-e", script, join(directory, "workspace"), context.callId]).exitCode;
      return { interrupted: true };
    });
    writeFileSync(join(s.workspace.canonicalPath, "a.txt"), "before");
    const pending = await s.executor.invoke(s.request, s.context, { ...allow, effect: "ask" });
    s.approvals.decide(pending.approval!.id, { clientDecisionKey: "approve-staged", decision: "allow_once" });
    await expect(s.executor.resumeApproved(s.context.callId, s.context)).rejects.toThrow("result_event_failed");
    expect(crashExit).toBe(79);
    s.db.exec("DROP TRIGGER lose_result"); s.db.close();
    const reopened = openDb(s.dbPath);
    try {
      expect(new ToolExecutionJournal(reopened).recoverInterrupted()).toBe(1);
      expect(reopened.query("SELECT status, recovery_disposition FROM tool_calls").get()).toEqual({ status: "cancelled", recovery_disposition: "verify_then_continue" });
      const output = reopened.query<{ canonical_json: string; is_error: number }, []>("SELECT canonical_json, is_error FROM tool_outputs").get()!;
      expect(output.is_error).toBe(1);
      expect(JSON.parse(output.canonical_json)).toMatchObject({ code: "TOOL_MUTATION_NOT_APPLIED", recovery: { outcome: "not_applied" } });
      expect(reopened.query("SELECT status FROM approval_requests").get()).toEqual({ status: "expired" });
      expect((await new ToolExecutor(reopened, s.registry, new ApprovalManager(reopened)).invoke(s.request, s.context, allow)).status).toBe("cancelled");
      expect(s.bodies()).toBe(1);
      expect(readFileSync(join(s.workspace.canonicalPath, "a.txt"), "utf8")).toBe("before");
    } finally { reopened.close(); }
  });

  it("rolls back a failed recovery event and later records verified success atomically", async () => {
    const s = setup();
    try {
      const pending = await s.executor.invoke(s.request, s.context, { ...allow, effect: "ask" });
      s.approvals.decide(pending.approval!.id, { clientDecisionKey: "approve", decision: "allow_once" });
      await expect(s.executor.resumeApproved(s.context.callId, s.context)).rejects.toThrow("result_event_failed");
      s.db.exec("DROP TRIGGER lose_result");
      s.db.exec(`CREATE TRIGGER lose_recovery BEFORE INSERT ON runtime_events WHEN NEW.id = 'tool-recovered:write-operation'
        BEGIN SELECT RAISE(ABORT, 'recovery_event_failed'); END`);
      const journal = new ToolExecutionJournal(s.db);
      expect(() => journal.recoverInterrupted()).toThrow("recovery_event_failed");
      expect(s.db.query("SELECT status FROM tool_calls").get()).toEqual({ status: "running" });
      expect(s.db.query("SELECT status FROM approval_requests").get()).toEqual({ status: "allowed" });
      expect(s.db.query("SELECT * FROM tool_outputs").get()).toBeNull();
      expect(s.db.query("SELECT id FROM runtime_events WHERE id = 'tool-recovered:write-operation'").get()).toBeNull();
      s.db.exec("DROP TRIGGER lose_recovery");
      expect(journal.recoverInterrupted()).toBe(1);
      expect(journal.recoverInterrupted()).toBe(0);
      expect(s.db.query("SELECT status FROM tool_calls").get()).toEqual({ status: "succeeded" });
      expect(s.bodies()).toBe(1);
    } finally { s.db.close(); }
  });

  it.each(["create_directory", "copy_path", "move_path", "delete_path", "create_archive", "create_document", "create_spreadsheet"])("verifies persisted %s evidence using the right paths and mutation kind", async (name) => {
    const input = name === "copy_path" || name === "move_path" ? { source: "source.txt", destination: "destination.txt" } : { path: "target" };
    const s = setup(async (_input, context) => {
      const policy = new WorkspacePathPolicy(join(directory, "workspace"));
      const options = { operationId: context.callId };
      if (name === "create_directory") return policy.createDirectory("target", options);
      if (name === "copy_path") return policy.createFile("destination.txt", policy.readBytes("source.txt", 100).bytes, options);
      if (name === "move_path") return policy.movePath("source.txt", "destination.txt", options);
      if (name === "delete_path") return policy.deletePath("target", options);
      return policy.createFile("target", Buffer.from("generated artifact"), options);
    }, { name, input });
    try {
      writeFileSync(join(s.workspace.canonicalPath, "source.txt"), "source content");
      if (name === "delete_path") writeFileSync(join(s.workspace.canonicalPath, "target"), "delete content");
      await expect(s.executor.invoke(s.request, s.context, allow)).rejects.toThrow("result_event_failed");
      s.db.exec("DROP TRIGGER lose_result");
      expect(new ToolExecutionJournal(s.db).recoverInterrupted()).toBe(1);
      expect(s.db.query("SELECT status FROM tool_calls").get()).toEqual({ status: "succeeded" });
      const output = JSON.parse(s.db.query<{ canonical_json: string }, []>("SELECT canonical_json FROM tool_outputs").get()!.canonical_json);
      expect(output).toMatchObject({ code: "TOOL_RECOVERED_APPLIED", recovery: { outcome: "applied", evidence: { path: name === "copy_path" ? "destination.txt" : name === "move_path" ? "source.txt" : "target" } } });
      expect(s.bodies()).toBe(1);
    } finally { s.db.close(); }
  });

  it.each(["missing workspace", "unsupported tool"])("keeps conservative Phase 4 behavior for %s", async (scenario) => {
    const s = setup(undefined, scenario === "unsupported tool" ? { name: "custom_writer" } : {});
    try {
      await expect(s.executor.invoke(s.request, s.context, allow)).rejects.toThrow("result_event_failed");
      s.db.exec("DROP TRIGGER lose_result");
      if (scenario === "missing workspace") s.db.exec("DELETE FROM workspaces");
      new ToolExecutionJournal(s.db).recoverInterrupted();
      expect(s.db.query("SELECT status, recovery_disposition FROM tool_calls").get()).toEqual({ status: "outcome_unknown", recovery_disposition: "verify_then_continue" });
      const output = JSON.parse(s.db.query<{ canonical_json: string }, []>("SELECT canonical_json FROM tool_outputs").get()!.canonical_json);
      expect(output.code).toBe("TOOL_OUTCOME_UNKNOWN");
      expect(output.recovery).toBeUndefined();
      expect(s.bodies()).toBe(1);
    } finally { s.db.close(); }
  });

  it("preserves committed canonical output and storage references instead of synthesizing recovery output", async () => {
    const s = setup(async (_input, context) => {
      new WorkspacePathPolicy(join(directory, "workspace")).writeText("a.txt", "complete", { operationId: context.callId });
      return { text: "x".repeat(100_000) };
    });
    try {
      s.db.exec("DROP TRIGGER lose_result");
      const pending = await s.executor.invoke(s.request, s.context, { ...allow, effect: "ask" });
      s.approvals.decide(pending.approval!.id, { clientDecisionKey: "approve-spilled", decision: "allow_once" });
      const succeeded = await s.executor.resumeApproved(s.context.callId, s.context);
      expect(succeeded.status).toBe("succeeded");
      const before = s.db.query("SELECT canonical_json, storage_key, preview_text FROM tool_outputs").get();
      expect(before).toMatchObject({ storage_key: expect.stringMatching(/^tool-result:/) });
      s.db.exec("UPDATE tool_calls SET status = 'running'");
      new ToolExecutionJournal(s.db).recoverInterrupted();
      expect(s.db.query("SELECT status FROM tool_calls").get()).toEqual({ status: "succeeded" });
      expect(s.db.query("SELECT canonical_json, storage_key, preview_text FROM tool_outputs").get()).toEqual(before);
      expect(s.db.query("SELECT status FROM approval_requests").get()).toEqual({ status: "expired" });
      expect(s.bodies()).toBe(1);
    } finally { s.db.close(); }
  });

});
