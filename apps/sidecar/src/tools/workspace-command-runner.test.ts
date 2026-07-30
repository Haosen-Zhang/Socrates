import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ToolContext } from "@socrates/core";
import { createMacOsSandboxCommandRunner, SupervisedCommandRunner } from "./workspace-command-runner";

describe("SupervisedCommandRunner", () => {
  let root: string;
  let context: ToolContext;
  const runner = new SupervisedCommandRunner((_workspaceRoot, input) => ({
    executable: process.execPath,
    argv: input.argv,
    env: { PATH: "/usr/bin:/bin" },
  }));

  beforeEach(() => {
    root = `${tmpdir()}/socrates-command-runner-${crypto.randomUUID()}`;
    mkdirSync(root, { recursive: true });
    context = {
      callId: "call",
      sessionId: "session",
      taskId: "task",
      turnId: "turn",
      agentId: "agent",
      workspaceId: "workspace",
      mode: "single_agent",
      phase: "executing",
      signal: new AbortController().signal,
    };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("escalates timeout from TERM to KILL for a signal-resistant process", async () => {
    writeFileSync(
      `${root}/stubborn.js`,
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n",
    );
    const started = performance.now();
    await expect(runner.run(root, {
      executable: "node",
      argv: ["stubborn.js"],
      timeoutMs: 100,
    }, context)).rejects.toThrow("tool_timed_out");
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("terminates the process group on cancellation", async () => {
    writeFileSync(
      `${root}/parent.js`,
      [
        "const { spawn } = require('node:child_process');",
        "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const controller = new AbortController();
    const execution = runner.run(root, {
      executable: "node",
      argv: ["parent.js"],
      timeoutMs: 5_000,
    }, { ...context, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(execution).rejects.toThrow("tool_cancelled");
  });

  it("bounds each output stream and reports truncation", async () => {
    writeFileSync(`${root}/noisy.js`, "process.stdout.write('x'.repeat(20000));\n");
    const result = await runner.run(root, {
      executable: "node",
      argv: ["noisy.js"],
    }, context);
    expect(result.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBe(8 * 1024);
  });
});

const macSandboxAvailable = process.platform === "darwin"
  && spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1) (allow default)", "/usr/bin/true"]).status === 0;
const macSandboxIt = macSandboxAvailable ? it : it.skip;

macSandboxIt("confines a real macOS command from following a workspace symlink outside", async () => {
  const root = `${tmpdir()}/socrates-command-sandbox-${crypto.randomUUID()}`;
  const outside = `${tmpdir()}/socrates-command-outside-${crypto.randomUUID()}.txt`;
  mkdirSync(root, { recursive: true });
  writeFileSync(outside, "outside-secret\n");
  writeFileSync(`${root}/.env`, "workspace-secret\n");
  symlinkSync(outside, `${root}/outside-link.txt`);
  const runner = createMacOsSandboxCommandRunner(new Map([
    ["grep", "/usr/bin/grep"],
    ["pwd", "/bin/pwd"],
  ]));
  const context: ToolContext = {
    callId: "call",
    sessionId: "session",
    taskId: "task",
    turnId: "turn",
    agentId: "agent",
    workspaceId: "workspace",
    mode: "single_agent",
    phase: "executing",
    signal: new AbortController().signal,
  };
  try {
    const baseline = await runner.run(root, { executable: "pwd", argv: [] }, context);
    expect(baseline.exitCode).toBe(0);
    expect(baseline.stdout.trim()).toBe(realpathSync(root));
    const result = await runner.run(root, {
      executable: "grep",
      argv: ["outside-secret", "outside-link.txt"],
    }, context);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("outside-secret");
    expect(result.stderr).toContain("Operation not permitted");
    const recursive = await runner.run(root, {
      executable: "grep",
      argv: ["-R", "workspace-secret", "."],
    }, context);
    expect(recursive.stdout).not.toContain("workspace-secret");
    expect(recursive.stderr).toContain("Operation not permitted");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

macSandboxIt("supports a read-only git status with argv preserved", async () => {
  const root = `${tmpdir()}/socrates-command-git-${crypto.randomUUID()}`;
  mkdirSync(root, { recursive: true });
  execFileSync("/usr/bin/git", ["init", "--quiet"], { cwd: root });
  writeFileSync(`${root}/change.txt`, "change\n");
  const gitPath = execFileSync("/usr/bin/xcrun", ["--find", "git"], { encoding: "utf-8" }).trim();
  const runner = createMacOsSandboxCommandRunner(new Map([["git", gitPath]]));
  const context: ToolContext = {
    callId: "call",
    sessionId: "session",
    taskId: "task",
    turnId: "turn",
    agentId: "agent",
    workspaceId: "workspace",
    mode: "single_agent",
    phase: "executing",
    signal: new AbortController().signal,
  };
  try {
    const result = await runner.run(root, {
      executable: "git",
      argv: ["status", "--short"],
    }, context);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("change.txt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
