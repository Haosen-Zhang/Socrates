import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspacePathPolicy } from "../workspace/path-policy";
import { createWorkspaceWriteBuiltins } from "./workspace-write-builtins";

describe("workspace-write builtins", () => {
  const tmp = join(tmpdir(), `socrates-ws-write-test-${crypto.randomUUID()}`);
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, ".gitkeep"), "");
  const policy = new WorkspacePathPolicy(tmp);
  const tools = createWorkspaceWriteBuiltins(policy);

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

  it("run_shell executes a command with stdout", async () => {
    const shellTool = tools.find((t) => t.name === "run_shell")!;
    expect(shellTool).toBeDefined();
    expect(shellTool.risk).toBe("destructive");

    const result = (await shellTool.execute!({ command: "echo", args: "hello test" }, {} as any)) as any;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello test");
  });

  it("run_shell captures stderr on failure", async () => {
    const shellTool = tools.find((t) => t.name === "run_shell")!;
    // Use a command that won't exist
    const result = (await shellTool.execute!({ command: "nonexistent_cmd_xyz", args: "" }, {} as any)) as any;
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBeTruthy();
  });
});
