import { spawn } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolContext } from "@socrates/core";
import { isSecretWorkspacePath } from "../workspace/path-policy";

const STREAM_LIMIT_BYTES = 8 * 1024;
const TERMINATION_GRACE_MS = 500;

export type StructuredCommandInput = {
  executable: string;
  argv: string[];
  timeoutMs?: number;
};

export type StructuredCommandResult = {
  executable: string;
  argv: string[];
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: false;
  cancelled: false;
  durationMs: number;
};

export interface WorkspaceCommandRunner {
  run(
    workspaceRoot: string,
    input: StructuredCommandInput,
    context: ToolContext,
  ): Promise<StructuredCommandResult>;
}

type Invocation = {
  executable: string;
  argv: string[];
  env: Record<string, string>;
};

export type CommandInvocationAdapter = (
  workspaceRoot: string,
  input: StructuredCommandInput,
) => Invocation;

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  state: { bytes: number; truncated: boolean; limit: number },
): void {
  const remaining = state.limit - state.bytes;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  const accepted = chunk.subarray(0, remaining);
  chunks.push(accepted);
  state.bytes += accepted.byteLength;
  if (accepted.byteLength < chunk.byteLength) state.truncated = true;
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The process may have exited between the state check and signal.
  }
}

function textOutput(chunks: Buffer[]): string {
  return Buffer.concat(chunks)
    .toString("utf-8")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "\uFFFD");
}

export class SupervisedCommandRunner implements WorkspaceCommandRunner {
  constructor(private readonly adapt: CommandInvocationAdapter, private readonly streamLimitBytes = STREAM_LIMIT_BYTES) {}

  async run(
    workspaceRoot: string,
    input: StructuredCommandInput,
    context: ToolContext,
  ): Promise<StructuredCommandResult> {
    if (context.signal.aborted) throw new Error("tool_cancelled");
    const invocation = this.adapt(workspaceRoot, input);
    const startedAt = performance.now();
    return await new Promise((resolve, reject) => {
      const child = spawn(invocation.executable, invocation.argv, {
        cwd: workspaceRoot,
        env: invocation.env,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const stdoutState = { bytes: 0, truncated: false, limit: this.streamLimitBytes };
      const stderrState = { bytes: 0, truncated: false, limit: this.streamLimitBytes };
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let terminating = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      child.stdout.on("data", (chunk: Buffer) => appendBounded(stdout, chunk, stdoutState));
      child.stderr.on("data", (chunk: Buffer) => appendBounded(stderr, chunk, stderrState));
      const terminate = () => {
        if (terminating) return;
        terminating = true;
        signalProcessGroup(child.pid, "SIGTERM");
        killTimer = setTimeout(() => signalProcessGroup(child.pid, "SIGKILL"), TERMINATION_GRACE_MS);
      };
      const onAbort = () => {
        if (timedOut) return;
        cancelled = true;
        terminate();
      };
      context.signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        if (cancelled) return;
        timedOut = true;
        terminate();
      }, input.timeoutMs ?? 30_000);

      const cleanup = () => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        context.signal.removeEventListener("abort", onAbort);
      };
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`shell_spawn_failed:${error.message}`));
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (cancelled) return reject(new Error("tool_cancelled"));
        if (timedOut) return reject(new Error("tool_timed_out"));
        resolve({
          executable: input.executable,
          argv: input.argv,
          exitCode: code ?? 1,
          signal,
          stdout: textOutput(stdout),
          stderr: textOutput(stderr),
          stdoutTruncated: stdoutState.truncated,
          stderrTruncated: stderrState.truncated,
          timedOut: false,
          cancelled: false,
          durationMs: Math.round(performance.now() - startedAt),
        });
      });
    });
  }
}

function sandboxString(value: string): string {
  return JSON.stringify(value);
}

function ancestorPaths(path: string): string[] {
  const ancestors: string[] = [];
  let cursor = dirname(path);
  while (cursor !== dirname(cursor)) {
    ancestors.push(cursor);
    cursor = dirname(cursor);
  }
  return ancestors;
}

function existingSecretPaths(
  workspaceRoot: string,
  allowGitMetadata: boolean,
): Array<{ path: string; directory: boolean }> {
  const found: Array<{ path: string; directory: boolean }> = [];
  const visit = (absoluteDirectory: string, relativeDirectory: string) => {
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = join(absoluteDirectory, entry.name);
      if (isSecretWorkspacePath(relativePath)) {
        if (allowGitMetadata && relativePath.split("/").includes(".git")) continue;
        found.push({ path: absolutePath, directory: entry.isDirectory() });
        continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(absolutePath, relativePath);
    }
  };
  visit(workspaceRoot, "");
  return found;
}

function macOsSandboxInvocation(
  workspaceRoot: string,
  input: StructuredCommandInput,
  executablePath: string,
): Invocation {
  const canonicalHome = realpathSync(homedir());
  const runtimeReadRoot = dirname(dirname(executablePath));
  const secretDenials = existingSecretPaths(workspaceRoot, input.executable === "git").flatMap(({ path, directory }) => {
    const matcher = `(${directory ? "subpath" : "literal"} ${sandboxString(path)})`;
    return [`(deny file-read* ${matcher})`, `(deny file-write* ${matcher})`];
  });
  const profile = [
    "(version 1)",
    '(import "system.sb")',
    "(deny network*)",
    "(deny file-write*)",
    `(allow file-write* (subpath ${sandboxString(workspaceRoot)}))`,
    `(deny file-read* (subpath ${sandboxString(canonicalHome)}) (subpath "/Users") (subpath "/private") (subpath "/Volumes") (subpath "/Applications") (subpath "/Library") (subpath "/opt") (subpath "/usr/local"))`,
    `(allow file-read-metadata ${ancestorPaths(workspaceRoot).map((path) => `(literal ${sandboxString(path)})`).join(" ")})`,
    `(allow file-read* (subpath ${sandboxString(workspaceRoot)}))`,
    `(allow file-read* (subpath ${sandboxString(runtimeReadRoot)}))`,
    ...secretDenials,
    `(allow process-exec (literal ${sandboxString(executablePath)}))`,
  ].join(" ");
  return {
    executable: "/usr/bin/sandbox-exec",
    argv: ["-p", profile, executablePath, ...input.argv],
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: workspaceRoot,
      TMPDIR: workspaceRoot,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      CI: "1",
      NO_COLOR: "1",
    },
  };
}

export function createMacOsSandboxCommandRunner(
  executablePaths: ReadonlyMap<string, string>,
): WorkspaceCommandRunner {
  return new SupervisedCommandRunner((workspaceRoot, input) => {
    const configured = executablePaths.get(input.executable);
    if (!configured || !existsSync(configured)) throw new Error("shell_executable_unavailable");
    const executablePath = realpathSync(configured);
    return macOsSandboxInvocation(realpathSync(workspaceRoot), input, executablePath);
  });
}
