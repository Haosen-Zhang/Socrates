import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspacePathPolicy } from "../workspace/path-policy";
import { SupervisedCommandRunner } from "./workspace-command-runner";
import { createWorkspaceWriteBuiltins } from "./workspace-write-builtins";

describe("workspace-write builtins", () => {
  const tmp = join(tmpdir(), `socrates-ws-write-test-${crypto.randomUUID()}`);
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, ".gitkeep"), "");
  const policy = new WorkspacePathPolicy(tmp);
  const commandPaths = new Map([
    ["echo", "/bin/echo"],
    ["git", "/usr/bin/git"],
  ]);
  const runner = new SupervisedCommandRunner((_workspaceRoot, input) => ({
    executable: commandPaths.get(input.executable) ?? input.executable,
    argv: input.argv,
    env: { PATH: "/usr/bin:/bin", HOME: tmp, TMPDIR: tmp },
  }));
  const tools = createWorkspaceWriteBuiltins(policy, runner);
  const context = {
    callId: "call",
    sessionId: "session",
    taskId: "task",
    turnId: "turn",
    agentId: "agent",
    mode: "single_agent",
    phase: "executing",
    signal: new AbortController().signal,
  } as const;

  // Note: workspace is created in tmpdir(), cleaned up by OS

  it("write_file creates a new file inside workspace", async () => {
    const writeTool = tools.find((t) => t.name === "write_file")!;
    expect(writeTool).toBeDefined();
    expect(writeTool.risk).toBe("high");

    const result = (await writeTool.execute!({ path: "hello.txt", content: "hello world\n" }, {} as any)) as any;
    expect(result.action).toBe("created");
    expect(result.path).toBe("hello.txt");
    expect(existsSync(join(tmp, "hello.txt"))).toBe(true);
    expect(readFileSync(join(tmp, "hello.txt"), "utf-8")).toContain("hello world");
  });

  it("write_file overwrites existing files", async () => {
    const writeTool = tools.find((t) => t.name === "write_file")!;
    // Create first
    await writeTool.execute!({ path: "overwrite.txt", content: "old line 1\nold line 2\n" }, {} as any);

    const result = (await writeTool.execute!({ path: "overwrite.txt", content: "new line 1\nnew line 2\nnew line 3\n" }, {} as any)) as any;
    expect(result.action).toBe("overwritten");
    expect(result.newLines).toBeGreaterThanOrEqual(3);
    expect(typeof result.previousLines).toBe("number");
    expect(readFileSync(join(tmp, "overwrite.txt"), "utf-8")).toContain("new line 1");
  });

  it("write_file rejects path traversal", async () => {
    const writeTool = tools.find((t) => t.name === "write_file")!;
    await expect(
      writeTool.execute!({ path: "../outside.txt", content: "nope" }, {} as any),
    ).rejects.toThrow();
  });

  it("write_file refuses to overwrite a hardlink to an outside inode", async () => {
    const writeTool = tools.find((tool) => tool.name === "write_file")!;
    const outside = join(tmp, "..", `outside-hardlink-${crypto.randomUUID()}.txt`);
    writeFileSync(outside, "outside");
    const { linkSync } = await import("node:fs");
    linkSync(outside, join(tmp, "hardlink.txt"));
    try {
      await expect(writeTool.execute!({ path: "hardlink.txt", content: "changed" }, context))
        .rejects.toThrow("workspace_hardlink_denied");
      expect(readFileSync(outside, "utf-8")).toBe("outside");
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("delete_path deletes an in-workspace file and an explicitly empty directory", async () => {
    const deleteTool = tools.find((tool) => tool.name === "delete_path")!;
    expect(deleteTool).toMatchObject({ risk: "destructive", capability: "workspace_write" });
    writeFileSync(join(tmp, "remove.txt"), "remove me");
    mkdirSync(join(tmp, "empty"));

    expect(deleteTool.validateInput?.({ path: "remove.txt" })).toEqual([]);
    await expect(deleteTool.execute!({ path: "remove.txt" }, context)).resolves.toMatchObject({
      action: "deleted",
      path: "remove.txt",
      kind: "file",
    });
    await expect(deleteTool.execute!({ path: "empty" }, context)).resolves.toMatchObject({
      action: "deleted",
      path: "empty",
      kind: "directory",
    });
    expect(existsSync(join(tmp, "remove.txt"))).toBe(false);
    expect(existsSync(join(tmp, "empty"))).toBe(false);
  });

  it("delete_path rejects non-empty directories, secrets, traversal, and symlinks", () => {
    const deleteTool = tools.find((tool) => tool.name === "delete_path")!;
    mkdirSync(join(tmp, "not-empty"), { recursive: true });
    writeFileSync(join(tmp, "not-empty", "keep.txt"), "keep");
    const outside = join(tmp, "..", `outside-${crypto.randomUUID()}.txt`);
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(tmp, "outside-link"));
    try {
      expect(deleteTool.validateInput?.({ path: "not-empty" })).toContain("workspace_directory_not_empty");
      expect(deleteTool.validateInput?.({ path: ".env" })).toContain("workspace_secret_path_denied");
      expect(deleteTool.validateInput?.({ path: "../outside.txt" })).toContain("workspace_path_traversal");
      expect(deleteTool.validateInput?.({ path: "outside-link" })).toContain("workspace_symlink_denied");
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("run_shell executes an allowlisted executable with argv preserved", async () => {
    const shellTool = tools.find((t) => t.name === "run_shell")!;
    expect(shellTool).toBeDefined();
    expect(shellTool).toMatchObject({ risk: "destructive", capability: "shell", generation: 2 });

    expect(shellTool.validateInput?.({ executable: "echo", argv: ["hello test"] })).toEqual([]);
    const result = (await shellTool.execute!({ executable: "echo", argv: ["hello test"] }, context)) as any;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello test");
    expect(result).toMatchObject({
      executable: "echo",
      argv: ["hello test"],
      stderr: "",
      timedOut: false,
      cancelled: false,
    });
  });

  it("run_shell rejects disallowed executables and shell metacharacter smuggling before approval", () => {
    const shellTool = tools.find((t) => t.name === "run_shell")!;
    expect(shellTool.validateInput?.({ executable: "/bin/bash", argv: ["-c", "echo"] }))
      .toContain("shell_executable_not_allowed");
    expect(shellTool.validateInput?.({ executable: "git", argv: ["status; rm", "-rf"] }))
      .toContain("shell_metacharacter_denied");
    expect(shellTool.validateInput?.({ executable: "echo", argv: ["hello|cat"] }))
      .toContain("shell_metacharacter_denied");
    expect(shellTool.validateInput?.({ executable: "echo", argv: ["sk-abcdefgh"] }))
      .toContain("shell_credential_argument_denied");
    expect(shellTool.validateInput?.({ executable: "echo", argv: ["--api-key=value"] }))
      .toContain("shell_credential_argument_denied");
    expect(shellTool.validateInput?.({ executable: "echo", argv: ["password=hunter2"] }))
      .toContain("shell_credential_argument_denied");
    expect(shellTool.validateInput?.({ executable: "cat", argv: ["/etc/passwd"] }))
      .toContain("shell_argument_path_outside");
    expect(shellTool.validateInput?.({ executable: "cat", argv: ["../outside"] }))
      .toContain("shell_argument_path_outside");
    expect(shellTool.validateInput?.({ executable: "git", argv: ["--git-dir=/tmp/outside", "status"] }))
      .toContain("shell_argument_path_outside");
    expect(shellTool.validateInput?.({ executable: "git", argv: ["-C../outside", "status"] }))
      .toContain("shell_argument_path_outside");
    expect(shellTool.validateInput?.({ executable: "grep", argv: ["SECRET", ".env"] }))
      .toContain("workspace_secret_path_denied");
  });

  it("run_shell captures stderr on failure", async () => {
    const shellTool = tools.find((t) => t.name === "run_shell")!;
    const result = (await shellTool.execute!({ executable: "git", argv: ["rev-parse", "missing-ref-xyz"] }, context)) as any;
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBeTruthy();
  });
});
