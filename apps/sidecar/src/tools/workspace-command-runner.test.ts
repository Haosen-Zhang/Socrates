import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { type ToolContext, isStructuredExecutionError } from "@socrates/core";
import { createMacOsSandboxCommandRunner, SupervisedCommandRunner } from "./workspace-command-runner";
import { discoverCommandExecutables } from "./command-tools";

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

  it("retains output beyond the preview in a complete spill reference", async () => {
    writeFileSync(`${root}/noisy.js`, "process.stdout.write('x'.repeat(20000)); process.stderr.write('failure details'); process.exitCode=7;\n");
    const full = { stdout: "", stderr: "" };
    const capturedRunner = new SupervisedCommandRunner((_root, input) => ({ executable: process.execPath, argv: input.argv, env: {} }), 8192, () => ({
      write(stream, chunk) { full[stream] += Buffer.from(chunk).toString("utf8"); },
      finish() { return { stdout: "output:stdout-ref", stderr: "output:stderr-ref" }; },
    }));
    const result = await capturedRunner.run(root, { executable: "node", argv: ["noisy.js"] }, context);
    expect(result.exitCode).toBe(7);
    expect(result.stdoutPreview.length).toBe(8192);
    expect(result.stderrPreview).toBe("failure details");
    expect(result.fullOutputRefs).toEqual({ stdout: "output:stdout-ref", stderr: "output:stderr-ref" });
    expect(full.stdout).toBe("x".repeat(20000));
    expect(full.stderr).toBe("failure details");
  });

  it("preserves exact argv and executes from a relative workspace cwd", async () => {
    mkdirSync(`${root}/subdir`);
    writeFileSync(`${root}/subdir/args.js`, "process.stdout.write(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()}));\n");
    const result = await runner.run(root, {
      executable: "node", argv: ["args.js", "one two", "literal;$HOME", "quote\"value"], cwd: "subdir",
    }, context);
    expect(JSON.parse(result.stdout)).toEqual({ argv: ["one two", "literal;$HOME", "quote\"value"], cwd: realpathSync(`${root}/subdir`) });
    expect(result.cwd).toBe("subdir");
  });

  it("kills a resistant descendant even when its parent closes pipes immediately on cancellation", async () => {
    writeFileSync(`${root}/descendant.js`, "process.on('SIGTERM',()=>{}); require('fs').writeFileSync('descendant.pid',String(process.pid)); setInterval(()=>{},1000);\n");
    writeFileSync(`${root}/parent.js`, "require('child_process').spawn(process.execPath,['descendant.js'],{stdio:'ignore'}); process.on('SIGTERM',()=>process.exit()); setInterval(()=>{},1000);\n");
    const controller = new AbortController();
    const execution = runner.run(root, { executable: "node", argv: ["parent.js"] }, { ...context, signal: controller.signal });
    while (!existsSync(`${root}/descendant.pid`)) await Bun.sleep(10);
    const pid = Number(readFileSync(`${root}/descendant.pid`, "utf-8"));
    controller.abort();
    await expect(execution).rejects.toThrow("tool_cancelled");
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (alive) process.kill(pid, "SIGKILL");
    expect(alive).toBe(false);
  });

  it("retains partial output and timeout metadata on the structured timeout error", async () => {
    writeFileSync(`${root}/partial.js`, "process.stdout.write('started'); setInterval(()=>{},1000);\n");
    let error: unknown;
    try { await runner.run(root, { executable: "node", argv: ["partial.js"], timeoutMs: 100 }, context); } catch (caught) { error = caught; }
    expect(isStructuredExecutionError(error)).toBe(true);
    expect((error as { result?: unknown }).result).toMatchObject({ stdoutPreview: "started", timedOut: true, cancelled: false });
  });

  it("does not spawn project code after cancellation during runtime preparation", async () => {
    writeFileSync(`${root}/mark.js`, "require('fs').writeFileSync('should-not-exist','started');");
    const preparing = new SupervisedCommandRunner(async (_root, input) => {
      await Bun.sleep(80);
      return { executable: process.execPath, argv: input.argv, env: {} };
    });
    const controller = new AbortController();
    const running = preparing.run(root, { executable: "node", argv: ["mark.js"] }, { ...context, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(running).rejects.toThrow("tool_cancelled");
    expect(existsSync(`${root}/should-not-exist`)).toBe(false);
  });

  it("stops background mutations before returning a normally exited leader's result", async () => {
    const shellRunner = new SupervisedCommandRunner(() => ({ executable: "/bin/sh", argv: ["-c", "(sleep 0.4; echo late > marker) >/dev/null 2>&1 & exit 0"], env: { PATH: "/usr/bin:/bin" } }));
    const result = await shellRunner.run(root, { executable: "test-shell", argv: [], timeoutMs: 100 }, context);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    await Bun.sleep(650);
    expect(existsSync(`${root}/marker`)).toBe(false);
  });

  it("joins a resistant background child after normal leader exit while preserving output and exit code", async () => {
    writeFileSync(`${root}/background.js`, "process.on('SIGTERM',()=>{}); require('fs').writeFileSync('background.pid',String(process.pid)); setInterval(()=>require('fs').writeFileSync('activity',String(Date.now())),20);\n");
    writeFileSync(`${root}/leader.js`, "require('child_process').spawn(process.execPath,['background.js'],{stdio:'ignore'}); const fs=require('fs'); const ready=setInterval(()=>{if(fs.existsSync('background.pid')){clearInterval(ready); console.log('leader output'); process.exit(7);}},10);\n");
    const full = { stdout: "", stderr: "" };
    const captured = new SupervisedCommandRunner((_root, input) => ({ executable: process.execPath, argv: input.argv, env: {} }), 8192, () => ({
      write(stream, chunk) { full[stream] += Buffer.from(chunk).toString("utf8"); },
      finish() { return { stdout: "opaque:stdout", stderr: "opaque:stderr" }; },
    }));
    const result = await captured.run(root, { executable: "node", argv: ["leader.js"], timeoutMs: 2_000 }, context);
    const pid = Number(readFileSync(`${root}/background.pid`, "utf8"));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (alive) process.kill(pid, "SIGKILL");
    expect(alive).toBe(false);
    expect(result).toMatchObject({ exitCode: 7, signal: null, stdoutPreview: "leader output\n", timedOut: false, cancelled: false, fullOutputRefs: { stdout: "opaque:stdout", stderr: "opaque:stderr" } });
    expect(full.stdout).toBe("leader output\n");
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

macSandboxIt("verifies an actual project with installed bun test, npm script and Python", async () => {
  const root = realpathSync(tmpdir()) + `/socrates-project-validation-${crypto.randomUUID()}`;
  mkdirSync(root);
  writeFileSync(`${root}/validation.test.ts`, "import {test,expect} from 'bun:test'; test('local',()=>expect(2+2).toBe(4));");
  writeFileSync(`${root}/package.json`, JSON.stringify({ scripts: { verify: "node verify.cjs", test: "bun test validation.test.ts" } }));
  writeFileSync(`${root}/verify.cjs`, "console.log('verified npm project');");
  writeFileSync(`${root}/verify.py`, "print('verified Python project')\n");
  const executables = discoverCommandExecutables();
  const runner = createMacOsSandboxCommandRunner(executables);
  const context: ToolContext = { callId: "call", sessionId: "session", taskId: "task", turnId: "turn", agentId: "agent", workspaceId: "workspace", mode: "single_agent", phase: "executing", signal: new AbortController().signal };
  try {
    for (const [executable, argv, expected] of [
      ["bun", ["test"], "1 pass"],
      ["bun", ["run", "test"], "1 pass"],
      ["npm", ["run", "verify"], "verified npm project"],
      ["python3", ["verify.py"], "verified Python project"],
    ] as const) {
      if (!executables.has(executable)) continue;
      const result = await runner.run(root, { executable, argv: [...argv], timeoutMs: 10_000 }, context);
      expect({ executable, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }).toMatchObject({ executable, exitCode: 0 });
      expect(result.stdout + result.stderr).toContain(expected);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

macSandboxIt("keeps network, environment, secrets and outside hardlinks denied for project code", async () => {
  const root = realpathSync(tmpdir()) + `/socrates-code-containment-${crypto.randomUUID()}`;
  const outside = `${root}-outside.txt`;
  mkdirSync(root);
  writeFileSync(outside, "outside-secret");
  writeFileSync(`${root}/.env`, "inside-secret");
  linkSync(outside, `${root}/ordinary.txt`);
  const server = createServer((socket) => { socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  writeFileSync(`${root}/inspect.cjs`, [
    "const fs=require('fs'); const result={};",
    "for(const path of ['.env','ordinary.txt']) { try { fs.readFileSync(path); result[path]=true; } catch { result[path]=false; } }",
    "try { fs.mkdirSync('.ssh'); fs.writeFileSync('.ssh/private-key','bad'); result.dynamicSecret=true; } catch { result.dynamicSecret=false; }",
    "result.inheritedSecret=process.env.SOCRATES_SECRET_FOR_TEST ?? null;",
    `const socket=require('net').connect(${address.port},'127.0.0.1');`,
    "socket.on('connect',()=>{result.network=true; socket.destroy(); console.log(JSON.stringify(result));});",
    "socket.on('error',()=>{result.network=false; console.log(JSON.stringify(result));});",
  ].join("\n"));
  const prior = process.env.SOCRATES_SECRET_FOR_TEST;
  process.env.SOCRATES_SECRET_FOR_TEST = "host-only-sentinel";
  const context: ToolContext = { callId: "call", sessionId: "session", taskId: "task", turnId: "turn", agentId: "agent", workspaceId: "workspace", mode: "single_agent", phase: "executing", signal: new AbortController().signal };
  try {
    const result = await createMacOsSandboxCommandRunner(discoverCommandExecutables()).run(root, { executable: "node", argv: ["inspect.cjs"], timeoutMs: 5_000 }, context);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ".env": false, "ordinary.txt": false, dynamicSecret: false, inheritedSecret: null, network: false });
  } finally {
    if (prior === undefined) delete process.env.SOCRATES_SECRET_FOR_TEST; else process.env.SOCRATES_SECRET_FOR_TEST = prior;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true }); rmSync(outside, { force: true });
  }
});
