import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { type ToolContext, validateJsonSchemaInput } from "@socrates/core";
import { WorkspacePathPolicy } from "../workspace/path-policy";
import { createCommandTools } from "./command-tools";
import { createMacOsSandboxCommandRunner, SupervisedCommandRunner } from "./workspace-command-runner";

describe("structured command tools", () => {
  let root: string;
  let context: ToolContext;
  beforeEach(() => {
    root = realpathSync(tmpdir()) + `/socrates-command-tools-${crypto.randomUUID()}`;
    mkdirSync(root);
    context = { callId: "call", sessionId: "session", taskId: "task", turnId: "turn", agentId: "agent", workspaceId: "workspace", mode: "single_agent", phase: "executing", signal: new AbortController().signal };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const runner = new SupervisedCommandRunner((_root, input) => ({ executable: process.execPath, argv: input.argv, env: { PATH: "/usr/bin:/bin" } }));

  it("runs a project test from its chosen workspace directory and preserves argv", async () => {
    mkdirSync(`${root}/project`);
    writeFileSync(`${root}/project/verify.ts`, "console.log(JSON.stringify(Bun.argv.slice(2))); process.exitCode=3;");
    const tool = createCommandTools(new WorkspacePathPolicy(root), runner).find((tool) => tool.name === "run_command")!;
    const result = await tool.execute!({ executable: "bun", argv: ["verify.ts", "one two", "literal;value"], cwd: "project" }, context) as Record<string, unknown>;
    expect(result.exitCode).toBe(3);
    expect(result.cwd).toBe("project");
    expect(JSON.parse(result.stdoutPreview as string)).toEqual(["one two", "literal;value"]);
    expect(tool.risk).toBe("high");
    expect(tool.idempotency).toBe("non_idempotent");
    expect(tool.capability).toBe("shell");
    expect(validateJsonSchemaInput(tool.outputSchema!, result)).toEqual([]);
  });

  it("exposes run_shell only as the same structured input compatibility alias", () => {
    const alias = createCommandTools(new WorkspacePathPolicy(root), runner).find((tool) => tool.name === "run_shell")!;
    expect(alias.validateInput!({ command: "bash -c 'bad'" }).length).toBeGreaterThan(0);
    expect(alias.validateInput!({ executable: "bun", argv: ["test"] })).toEqual([]);
  });

  it.each(["bun", "npm", "node", "python3", "pytest", "cargo", "go", "git"])("permits approved local validation with %s", (executable) => {
    const tool = createCommandTools(new WorkspacePathPolicy(root), runner)[0]!;
    expect(tool.validateInput!({ executable, argv: [executable === "git" ? "status" : "test"] })).toEqual([]);
  });

  it("rejects unknown shell executables, secrets, outside paths and invalid deadlines", async () => {
    const tool = createCommandTools(new WorkspacePathPolicy(root), runner)[0]!;
    for (const input of [
      { executable: "bash", argv: ["-c", "pwd"] },
      { executable: "node", argv: ["../escape.js"] },
      { executable: "node", argv: ["--config=/etc/config"] },
      { executable: "node", argv: [".env"] },
      { executable: "bun", argv: ["test"], cwd: "../outside" },
      { executable: "bun", argv: ["test"], timeoutMs: 0 },
      { executable: "bun", argv: ["test"], timeoutMs: Number.NaN },
    ]) {
      expect(tool.validateInput!(input).length).toBeGreaterThan(0);
      await expect(tool.execute!(input, context)).rejects.toThrow("invalid_tool_input");
    }
  });

  it("rejects a symlink cwd and checks argument paths relative to cwd", () => {
    mkdirSync(`${root}/project`);
    symlinkSync(tmpdir(), `${root}/outside`);
    symlinkSync(tmpdir(), `${root}/project/escape.js`);
    const tool = createCommandTools(new WorkspacePathPolicy(root), runner)[0]!;
    expect(tool.validateInput!({ executable: "bun", argv: ["test"], cwd: "outside" })).toContain("workspace_symlink_denied");
    expect(tool.validateInput!({ executable: "node", argv: ["escape.js"], cwd: "project" })).toContain("workspace_symlink_denied");
  });

  it("keeps Git content-reading commands unavailable until a scoped tool can exclude historical secrets", () => {
    const tool = createCommandTools(new WorkspacePathPolicy(root), runner)[0]!;
    for (const argv of [["diff"], ["show", "HEAD"], ["log", "-p"], ["push"]]) {
      expect(tool.validateInput!({ executable: "git", argv })).toContain("shell_git_scope_requires_dedicated_tool");
    }
    expect(tool.validateInput!({ executable: "git", argv: ["rev-parse", "--show-toplevel"] })).toEqual([]);
  });

  it("fails closed before spawn when macOS sandbox support is unavailable", async () => {
    const unsupported = createMacOsSandboxCommandRunner(new Map([["bun", process.execPath]]), undefined, "linux");
    await expect(unsupported.run(root, { executable: "bun", argv: ["test"] }, context)).rejects.toThrow("shell_sandbox_unavailable");
    expect(existsSync(`${root}/test`)).toBe(false);
  });
});
