import { execFile, spawn } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolContext } from "@socrates/core";
import { isSecretWorkspacePath } from "../workspace/path-policy";
import { WorkspacePathPolicy } from "../workspace/path-policy";
import { withToolDeadline } from "./tool-deadline";

const STREAM_LIMIT_BYTES = 8 * 1024;
const TERMINATION_GRACE_MS = 500;

export type StructuredCommandInput = {
  executable: string;
  argv: string[];
  timeoutMs?: number;
  /** Workspace-relative working directory; never interpreted by a shell. */
  cwd?: string;
};

export type StructuredCommandResult = {
  executable: string;
  argv: string[];
  cwd: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutPreview: string;
  stderrPreview: string;
  /** Opaque host-owned output-store references, never arbitrary local paths. */
  fullOutputRefs?: { stdout: string; stderr: string };
  captureAvailable: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
};

export type CommandOutputCapture = {
  write(stream: "stdout" | "stderr", chunk: Uint8Array): void;
  finish(): { stdout: string; stderr: string };
};
export type CommandCaptureFactory = (context: ToolContext) => CommandOutputCapture;

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
  context: ToolContext,
) => Invocation | Promise<Invocation>;

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
  constructor(
    private readonly adapt: CommandInvocationAdapter,
    private readonly streamLimitBytes = STREAM_LIMIT_BYTES,
    private readonly captureFactory?: CommandCaptureFactory,
  ) {}

  async run(
    workspaceRoot: string,
    input: StructuredCommandInput,
    context: ToolContext,
  ): Promise<StructuredCommandResult> {
    return withToolDeadline(context, input.timeoutMs ?? 30_000, (derived) => this.runSupervised(workspaceRoot, input, derived));
  }

  private async runSupervised(workspaceRoot: string, input: StructuredCommandInput, context: ToolContext): Promise<StructuredCommandResult> {
    if (context.signal.aborted) throw new Error("tool_cancelled");
    const policy = new WorkspacePathPolicy(workspaceRoot);
    const resolvedCwd = policy.resolveExisting(input.cwd ?? ".");
    if (isSecretWorkspacePath(resolvedCwd.relativePath)) throw new Error("workspace_secret_path_denied");
    if (!lstatSync(resolvedCwd.absolutePath).isDirectory()) throw new Error("workspace_not_directory");
    const invocation = await this.adapt(workspaceRoot, input, context);
    if (context.signal.aborted) throw context.signal.reason;
    const capture = this.captureFactory?.(context);
    const startedAt = performance.now();
    return await new Promise((resolve, reject) => {
      const child = spawn(invocation.executable, invocation.argv, {
        cwd: resolvedCwd.absolutePath,
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
      let termination: Promise<void> | undefined;
      let captureError: unknown;

      const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
        appendBounded(stream === "stdout" ? stdout : stderr, chunk, stream === "stdout" ? stdoutState : stderrState);
        try { capture?.write(stream, chunk); } catch (error) { captureError ??= error; terminate(); }
      };
      child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
      const terminate = () => {
        if (terminating) return;
        terminating = true;
        signalProcessGroup(child.pid, "SIGTERM");
        // Do not clear escalation when the direct child closes: a resistant
        // descendant may have closed its inherited pipes and still be alive.
        termination = new Promise((done) => setTimeout(() => {
          signalProcessGroup(child.pid, "SIGKILL");
          // Allow the kernel/reaper to observe SIGKILL before another sample.
          setTimeout(done, 25);
        }, TERMINATION_GRACE_MS));
      };
      const onAbort = () => {
        const reason = context.signal.reason as { detail?: { code?: string } } | undefined;
        timedOut = reason?.detail?.code === "TOOL_TIMEOUT";
        cancelled = !timedOut;
        terminate();
      };
      context.signal.addEventListener("abort", onAbort, { once: true });
      if (context.signal.aborted) onAbort();

      const cleanup = () => {
        context.signal.removeEventListener("abort", onAbort);
      };
      child.once("error", async (error) => {
        if (settled) return;
        settled = true;
        await termination;
        cleanup();
        reject(new Error(`shell_spawn_failed:${error.message}`));
      });
      child.once("close", async (code, signal) => {
        if (settled) return;
        settled = true;
        await termination;
        cleanup();
        if (captureError) return reject(captureError);
        let fullOutputRefs: { stdout: string; stderr: string } | undefined;
        try { fullOutputRefs = capture?.finish(); } catch (error) { return reject(error); }
        const stdoutPreview = textOutput(stdout);
        const stderrPreview = textOutput(stderr);
        const result: StructuredCommandResult = {
          executable: input.executable,
          argv: input.argv,
          cwd: resolvedCwd.relativePath || ".",
          exitCode: code ?? 1,
          signal,
          stdout: stdoutPreview,
          stderr: stderrPreview,
          stdoutPreview,
          stderrPreview,
          ...(fullOutputRefs ? { fullOutputRefs } : {}),
          captureAvailable: capture !== undefined,
          stdoutTruncated: stdoutState.truncated,
          stderrTruncated: stderrState.truncated,
          timedOut,
          cancelled,
          durationMs: Math.round(performance.now() - startedAt),
        };
        if (cancelled || timedOut) {
          // Preserve the shared deadline reason identity: outer execution
          // policy propagates it unchanged, including bounded partial output.
          const error = context.signal.reason instanceof Error ? context.signal.reason : new Error("tool_cancelled");
          Object.assign(error, { result });
          return reject(error);
        }
        resolve(result);
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
      if (entry.isFile() && lstatSync(absolutePath).nlink > 1) {
        found.push({ path: absolutePath, directory: false });
        continue;
      }
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

async function macOsSandboxInvocation(
  workspaceRoot: string,
  input: StructuredCommandInput,
  executablePath: string,
  executablePaths: ReadonlyMap<string, string>,
  context: ToolContext,
): Promise<Invocation> {
  const canonicalHome = realpathSync(homedir());
  const installedPaths = [...new Set([...executablePaths.values()].filter(existsSync).map((path) => realpathSync(path)))];
  const runtimeReadRoots = [...new Set(installedPaths.map((path) => dirname(dirname(path))))]
    .filter((path) => path !== "/" && path !== "/usr");
  // Homebrew runtimes link libraries in sibling package directories. Grant
  // those concrete dylibs rather than granting all of /opt or the user home.
  const runtimeLibraries = new Set<string>();
  const inspected = new Set<string>();
  const pending = installedPaths.filter((path) => !path.startsWith("/usr/") && !path.startsWith("/bin/"));
  while (pending.length && inspected.size < 128) {
    if (context.signal.aborted) throw context.signal.reason;
    const path = pending.shift()!;
    if (inspected.has(path)) continue;
    inspected.add(path);
    const listing = await new Promise<string>((resolve) => {
      execFile("/usr/bin/otool", ["-L", path], { encoding: "utf-8", signal: context.signal, timeout: 1_000, killSignal: "SIGKILL" }, (error, stdout) => resolve(error ? "" : stdout));
    }); // Scripts/static binaries do not have dylib metadata.
    for (const line of listing.split("\n")) {
      const dependency = /^\s+(\/.*?)\s+\(compatibility version /.exec(line)?.[1];
      if (!dependency || dependency.startsWith("/usr/lib/") || dependency.startsWith("/System/") || !existsSync(dependency)) continue;
      const canonical = realpathSync(dependency);
      runtimeLibraries.add(dependency); runtimeLibraries.add(canonical);
      if (!inspected.has(canonical)) pending.push(canonical);
    }
  }
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
    ...runtimeReadRoots.map((path) => `(allow file-read* file-map-executable (subpath ${sandboxString(path)}))`),
    ...[...new Set([...runtimeLibraries].map(dirname))].map((path) => `(allow file-read* file-map-executable (subpath ${sandboxString(path)}))`),
    ...[...new Set([...runtimeLibraries, ...installedPaths].flatMap(ancestorPaths))].map((path) => `(allow file-read-metadata (literal ${sandboxString(path)}))`),
    // Dynamic secret names remain denied even when project code creates them
    // after the initial scan. Network denial applies to descendants as well.
    `(deny file-read* file-write* (regex ${sandboxString(`${workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(.*\\/)?(\\.env|\\.ssh|\\.gnupg|\\.aws|\\.npmrc|\\.pypirc)(/.*)?$`)}))`,
    ...secretDenials,
    // Approved project validators may invoke interpreters, compilers, linkers
    // and freshly built workspace binaries. Every descendant inherits the
    // same filesystem/network sandbox; the public API still uses exact argv.
    "(allow process-exec process-fork)",
  ].join(" ");
  return {
    executable: "/usr/bin/sandbox-exec",
    argv: ["-p", profile, executablePath, ...input.argv],
    env: {
      PATH: [...new Set([...installedPaths.map(dirname), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":"),
      HOME: workspaceRoot,
      TMPDIR: workspaceRoot,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      CI: "1",
      NO_COLOR: "1",
      TERM: "dumb",
      PAGER: "cat",
      GIT_PAGER: "cat",
      npm_config_offline: "true",
      CARGO_NET_OFFLINE: "true",
      GOPROXY: "off",
      GOSUMDB: "off",
      OPENSSL_CONF: "/dev/null",
    },
  };
}

export function createMacOsSandboxCommandRunner(
  executablePaths: ReadonlyMap<string, string>,
  captureFactory?: CommandCaptureFactory,
  platform: NodeJS.Platform = process.platform,
): WorkspaceCommandRunner {
  return new SupervisedCommandRunner((workspaceRoot, input, context) => {
    if (platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) throw new Error("shell_sandbox_unavailable");
    const configured = executablePaths.get(input.executable);
    if (!configured || !existsSync(configured)) throw new Error("shell_executable_unavailable");
    const executablePath = realpathSync(configured);
    return macOsSandboxInvocation(realpathSync(workspaceRoot), input, executablePath, executablePaths, context);
  }, STREAM_LIMIT_BYTES, captureFactory);
}
