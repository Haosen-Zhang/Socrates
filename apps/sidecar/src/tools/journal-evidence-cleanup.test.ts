import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import type { PermissionEvaluation, ToolContext, ToolDefinition } from "@socrates/core";
import { openDb } from "../db";
import { ApprovalManager } from "../approvals/manager";
import { WorkspaceManager } from "../workspace/manager";
import { mutationNames } from "../workspace/mutation-evidence";
import { WorkspacePathPolicy } from "../workspace/path-policy";
import { ToolExecutor } from "./executor";
import { ToolExecutionJournal } from "./execution-journal";
import { ToolRegistry } from "./registry";
import { createWorkspaceWriteBuiltins } from "./workspace-write-builtins";

const allow: PermissionEvaluation = { effect: "allow", risk: "high", matchedRuleIds: [], reasonCode: "test", freshHumanRequired: false, policyVersion: 1 };

describe("commit-aware mutation evidence cleanup", () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "socrates-evidence-cleanup-")); mkdirSync(join(directory, "workspace")); });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function setup(overrides?: (tools: ToolDefinition[], policy: WorkspacePathPolicy) => ToolDefinition[]) {
    const dbPath = join(directory, "state.sqlite");
    const db = openDb(dbPath);
    const workspace = new WorkspaceManager(db).select(join(directory, "workspace"));
    const policy = new WorkspacePathPolicy(workspace.canonicalPath);
    const definitions = createWorkspaceWriteBuiltins(policy);
    const registry = new ToolRegistry(overrides ? overrides(definitions, policy) : definitions);
    const executor = new ToolExecutor(db, registry, new ApprovalManager(db));
    const invoke = (name: string, input: unknown, id = `${name}-${crypto.randomUUID()}`) => {
      const context: ToolContext = { callId: id, sessionId: "session", taskId: "run", turnId: "turn", stepId: "step", agentId: "agent", mode: "single_agent", phase: "executing", signal: new AbortController().signal };
      return executor.invoke({ stableKey: id, name, generation: 1, input, workspaceIdentity: workspace.identityHash, policyVersion: 1 }, context, allow);
    };
    return { db, dbPath, workspace, policy, invoke };
  }

  it("supports actual executor write, directory copy, archive and empty-directory deletion in sequence", async () => {
    const s = setup();
    try {
      expect((await s.invoke("write_file", { path: "docs/a.txt", content: "hello" })).status).toBe("succeeded");
      expect((await s.invoke("copy_path", { source: "docs", destination: "copied" })).status).toBe("succeeded");
      expect((await s.invoke("create_archive", { path: "exports/docs.zip", sources: ["docs"] })).status).toBe("succeeded");
      const files = unzipSync(readFileSync(join(s.workspace.canonicalPath, "exports/docs.zip")));
      expect(Object.keys(files)).toEqual(["docs/a.txt"]);
      expect(Buffer.from(files["docs/a.txt"]!).toString("utf8")).toBe("hello");
      expect((await s.invoke("delete_path", { path: "docs/a.txt" })).status).toBe("succeeded");
      expect((await s.invoke("delete_path", { path: "docs" })).status).toBe("succeeded");
      expect(existsSync(join(s.workspace.canonicalPath, "docs"))).toBe(false);
      expect(readdirSync(s.workspace.canonicalPath).filter((name) => name.startsWith(".socrates-"))).toEqual([]);
      expect(readFileSync(join(s.workspace.canonicalPath, "copied/a.txt"), "utf8")).toBe("hello");
    } finally { s.db.close(); }
  });

  it("keeps recoverable proof until result commit, then cleans after verified recovery commit", async () => {
    const s = setup();
    try {
      s.db.exec(`CREATE TRIGGER fail_result BEFORE INSERT ON tool_outputs BEGIN SELECT RAISE(ABORT, 'result_failed'); END`);
      await expect(s.invoke("write_file", { path: "docs/a.txt", content: "hello" }, "pending-write")).rejects.toThrow("result_failed");
      const journalPath = join(s.workspace.canonicalPath, "docs", mutationNames("pending-write").journal);
      expect(existsSync(journalPath)).toBe(true);
      expect(s.policy.recoverMutation({ operationId: "pending-write", kind: "write", path: "docs/a.txt" }).outcome).toBe("applied");
      expect(() => s.policy.snapshotTree("docs", { maxEntries: 10, maxBytes: 100 })).toThrow("workspace_secret_path_denied");
      s.db.exec("DROP TRIGGER fail_result");
      expect(new ToolExecutionJournal(s.db).recoverInterrupted()).toBe(1);
      expect(s.db.query("SELECT status FROM tool_calls").get()).toEqual({ status: "succeeded" });
      expect(existsSync(journalPath)).toBe(false);
      expect(s.policy.snapshotTree("docs", { maxEntries: 10, maxBytes: 100 }).totalBytes).toBe(5);
    } finally { s.db.close(); }
  });

  it("retains proof when the recovery transaction itself fails", async () => {
    const s = setup();
    try {
      s.db.exec(`CREATE TRIGGER fail_result BEFORE INSERT ON tool_outputs BEGIN SELECT RAISE(ABORT, 'result_failed'); END`);
      await expect(s.invoke("write_file", { path: "docs/a.txt", content: "hello" }, "pending-write")).rejects.toThrow("result_failed");
      s.db.exec("DROP TRIGGER fail_result");
      s.db.exec(`CREATE TRIGGER fail_recovery BEFORE INSERT ON runtime_events WHEN NEW.id = 'tool-recovered:pending-write'
        BEGIN SELECT RAISE(ABORT, 'recovery_failed'); END`);
      expect(() => new ToolExecutionJournal(s.db).recoverInterrupted()).toThrow("recovery_failed");
      expect(s.policy.recoverMutation({ operationId: "pending-write", kind: "write", path: "docs/a.txt" }).outcome).toBe("applied");
      expect(s.db.query("SELECT status FROM tool_calls").get()).toEqual({ status: "running" });
    } finally { s.db.close(); }
  });

  it("keeps durable success if cleanup cannot verify a hardlinked journal and retries cleanup on startup", async () => {
    const s = setup((tools, policy) => tools.map((tool) => tool.name !== "write_file" ? tool : {
      ...tool, execute: async (input, context) => {
        const output = await tool.execute!(input, context);
        linkSync(join(policy.canonicalRoot, "docs", mutationNames(context.toolOperationId!).journal), join(directory, "journal-alias"));
        return output;
      },
    }));
    expect((await s.invoke("write_file", { path: "docs/a.txt", content: "hello" }, "deferred-cleanup")).status).toBe("succeeded");
    const journalPath = join(s.workspace.canonicalPath, "docs", mutationNames("deferred-cleanup").journal);
    expect(existsSync(journalPath)).toBe(true);
    expect(readFileSync(join(directory, "journal-alias"), "utf8")).toContain("deferred-cleanup");
    unlinkSync(join(directory, "journal-alias"));
    writeFileSync(join(s.workspace.canonicalPath, "docs/a.txt"), "changed");
    s.db.close();
    const reopened = openDb(s.dbPath);
    try {
      expect(new ToolExecutionJournal(reopened).recoverInterrupted()).toBe(0);
      expect(reopened.query("SELECT status FROM tool_calls").get()).toEqual({ status: "succeeded" });
      expect(existsSync(journalPath)).toBe(false);
      expect(s.policy.snapshotTree("docs", { maxEntries: 10, maxBytes: 100 }).totalBytes).toBe(7);
      expect(readFileSync(join(s.workspace.canonicalPath, "docs/a.txt"), "utf8")).toBe("changed");
    } finally { reopened.close(); }
  });
  it("cleans a verified deletion quarantine only after its recovered success commits", async () => {
    let crashExit = -1;
    const s = setup((tools, policy) => tools.map((tool) => tool.name !== "delete_path" ? tool : {
      ...tool, execute: async (input, context) => {
        const { path } = input as { path: string };
        const script = `
          import { mock } from "bun:test";
          import * as fs from "node:fs";
          const sync = fs.fsyncSync;
          let directories = 0;
          mock.module("node:fs", () => ({ ...fs, fsyncSync(fd) {
            sync(fd);
            if (fs.fstatSync(fd).isDirectory() && ++directories === 2) process.exit(81);
          }}));
          const { WorkspacePathPolicy } = await import(${JSON.stringify(new URL("../workspace/path-policy.ts", import.meta.url).pathname)});
          new WorkspacePathPolicy(process.argv[1]).deletePath(process.argv[2], { operationId: process.argv[3] });
        `;
        crashExit = Bun.spawnSync([process.execPath, "-e", script, policy.canonicalRoot, path, context.toolOperationId!]).exitCode;
        return { action: "deleted", path, kind: "file" };
      },
    }));
    try {
      expect((await s.invoke("write_file", { path: "docs/a.txt", content: "hello" })).status).toBe("succeeded");
      s.db.exec(`CREATE TRIGGER fail_result BEFORE INSERT ON tool_outputs BEGIN SELECT RAISE(ABORT, 'result_failed'); END`);
      await expect(s.invoke("delete_path", { path: "docs/a.txt" }, "quarantined-delete")).rejects.toThrow("result_failed");
      expect(crashExit).toBe(81);
      const stage = join(s.workspace.canonicalPath, "docs", mutationNames("quarantined-delete").stage);
      expect(readFileSync(stage, "utf8")).toBe("hello");
      s.db.exec("DROP TRIGGER fail_result");
      expect(new ToolExecutionJournal(s.db).recoverInterrupted()).toBe(1);
      expect(existsSync(stage)).toBe(false);
      expect(readdirSync(join(s.workspace.canonicalPath, "docs"))).toEqual([]);
      // Use the ordinary production delete definition for the now-empty parent.
      const executor = new ToolExecutor(s.db, new ToolRegistry(createWorkspaceWriteBuiltins(s.policy)), new ApprovalManager(s.db));
      const context: ToolContext = { callId: "delete-parent", sessionId: "session", taskId: "run", turnId: "turn", stepId: "step", agentId: "agent", mode: "single_agent", phase: "executing", signal: new AbortController().signal };
      expect((await executor.invoke({ stableKey: "delete-parent", name: "delete_path", generation: 1, input: {path: "docs"}, workspaceIdentity: s.workspace.identityHash, policyVersion: 1 }, context, allow)).status).toBe("succeeded");
    } finally { s.db.close(); }
  });

});
