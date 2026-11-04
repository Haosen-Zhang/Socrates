/**
 * Native structured command tools. Availability grants no permission: project
 * scripts are high risk and the host requires exact, fresh command approval.
 * Deadline semantics are per attempt; the shared policy owns the AbortSignal.
 * Terminal environment/spill design informed by DeepSeek Harness bash-local
 * at 8bd073392eef6f54e921a093b95076248eb08cbb (MIT); no shell-string API reused.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonSchema, ToolContext, ToolDefinition } from "@socrates/core";
import { containsCredentialMaterial } from "../security/redaction";
import { isSecretWorkspacePath, WorkspacePathPolicy } from "../workspace/path-policy";
import {
  type CommandCaptureFactory,
  createMacOsSandboxCommandRunner,
  type StructuredCommandInput,
  type WorkspaceCommandRunner,
} from "./workspace-command-runner";

const COMMANDS = ["echo", "pwd", "uname", "bun", "npm", "node", "python", "python3", "pytest", "cargo", "go", "git"] as const;
const ALLOWED_COMMANDS = new Set<string>(COMMANDS);
const GIT_COMMANDS = new Set(["status", "rev-parse"]);
const TIMEOUT_MAX_MS = 120_000;
const OUTSIDE_PATH = /^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/])/;
const TRAVERSAL_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/** Resolve known local runtimes only from host-owned installation locations. */
export function discoverCommandExecutables(): ReadonlyMap<string, string> {
  const roots = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".bun/bin"), join(homedir(), ".cargo/bin"), "/usr/bin", "/bin"];
  const found = new Map<string, string>();
  for (const name of COMMANDS) {
    for (const root of roots) {
      const path = join(root, name);
      if (existsSync(path) && lstatSync(realpathSync(path)).isFile()) {
        found.set(name, realpathSync(path));
        break;
      }
    }
  }
  // /usr/bin/git is a developer-tools launcher on macOS; invoking its actual
  // binary avoids granting a command access to the launcher's broader services.
  try {
    const git = join(realpathSync("/var/db/xcode_select_link"), "usr/bin/git");
    if (existsSync(git)) found.set("git", realpathSync(git));
  } catch { /* No selected Xcode installation. */ }
  return found;
}

function validateCommand(policy: WorkspacePathPolicy, input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["expected:object"];
  const record = input as Record<string, unknown>;
  const { executable, argv, cwd, timeoutMs } = record;
  const errors: string[] = [];
  for (const key of Object.keys(record)) if (!["executable", "argv", "cwd", "timeoutMs"].includes(key)) errors.push(`unknown:${key}`);
  if (typeof executable !== "string" || !ALLOWED_COMMANDS.has(executable)) errors.push("shell_executable_not_allowed");
  let cwdRelative = "";
  try {
    if (cwd !== undefined && typeof cwd !== "string") throw new Error("shell_cwd_invalid");
    const resolved = policy.resolveExisting(cwd as string | undefined ?? ".");
    cwdRelative = resolved.relativePath;
    if (isSecretWorkspacePath(cwdRelative)) throw new Error("workspace_secret_path_denied");
    if (!lstatSync(resolved.absolutePath).isDirectory()) throw new Error("workspace_not_directory");
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  if (!Array.isArray(argv) || !argv.every((arg) => typeof arg === "string")) {
    errors.push("shell_argv_must_be_strings");
  } else {
    if (argv.length > 128 || argv.reduce((sum, arg) => sum + arg.length, 0) > 8192) errors.push("shell_argv_too_large");
    for (const argument of argv as string[]) {
      if (argument.includes("\0")) errors.push("shell_nul_denied");
      if (containsCredentialMaterial(argument)) errors.push("shell_credential_argument_denied");
      const value = argument.startsWith("-") && argument.includes("=") ? argument.slice(argument.indexOf("=") + 1)
        : argument.startsWith("-C") && argument.length > 2 ? argument.slice(2) : argument;
      if (OUTSIDE_PATH.test(value) || TRAVERSAL_SEGMENT.test(value) || value.startsWith("file:")) errors.push("shell_argument_path_outside");
      const candidates = [value, value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : ""].filter(Boolean);
      for (const candidate of candidates) {
        if (isSecretWorkspacePath(candidate)) errors.push("workspace_secret_path_denied");
        if (!candidate.startsWith("-") && !OUTSIDE_PATH.test(candidate) && !TRAVERSAL_SEGMENT.test(candidate)) {
          const path = join(cwdRelative, candidate);
          try {
            if (existsSync(join(policy.canonicalRoot, path))) {
              const resolved = policy.resolveExisting(path);
              if (lstatSync(resolved.absolutePath).isFile() && lstatSync(resolved.absolutePath).nlink > 1) errors.push("workspace_hardlink_denied");
            } else if (candidate.includes("/") || candidate.includes("\\")) {
              policy.resolveMutationTarget(path);
            }
          } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
        }
      }
    }
    if (executable === "git" && !GIT_COMMANDS.has(argv[0] ?? "")) {
      errors.push("shell_argument_not_allowed", "shell_git_scope_requires_dedicated_tool");
    }
  }
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 100 || (timeoutMs as number) > TIMEOUT_MAX_MS)) errors.push("shell_timeout_invalid");
  return [...new Set(errors)];
}

const inputSchema: JsonSchema = {
  type: "object", additionalProperties: false, required: ["executable", "argv"],
  examples: [{ executable: "bun", argv: ["test"], timeoutMs: 30_000 }, { executable: "npm", argv: ["run", "typecheck"], cwd: "apps/desktop", timeoutMs: 60_000 }],
  properties: {
    executable: { type: "string", enum: [...COMMANDS], description: "Installed local validation runtime; availability does not grant permission." },
    argv: { type: "array", items: { type: "string" }, maxItems: 128, description: "Exact arguments. No shell parsing or expansion." },
    cwd: { type: "string", description: "Existing workspace-relative working directory; defaults to workspace root." },
    timeoutMs: { type: "integer", minimum: 100, maximum: TIMEOUT_MAX_MS, description: "Execution deadline for one attempt; cancellation then waits for bounded process cleanup." },
  },
};

const outputSchema: JsonSchema = {
  type: "object", additionalProperties: false,
  required: ["executable", "argv", "cwd", "exitCode", "signal", "stdout", "stderr", "stdoutPreview", "stderrPreview", "stdoutTruncated", "stderrTruncated", "captureAvailable", "timedOut", "cancelled", "durationMs"],
  properties: {
    executable: { type: "string" }, argv: { type: "array", items: { type: "string" } }, cwd: { type: "string" },
    exitCode: { type: "integer" }, signal: { anyOf: [{ type: "string" }, { type: "null" }] },
    stdout: { type: "string" }, stderr: { type: "string" }, stdoutPreview: { type: "string" }, stderrPreview: { type: "string" },
    stdoutTruncated: { type: "boolean" }, stderrTruncated: { type: "boolean" }, captureAvailable: { type: "boolean" },
    fullOutputRefs: { type: "object", additionalProperties: false, required: ["stdout", "stderr"], properties: { stdout: { type: "string" }, stderr: { type: "string" } } },
    timedOut: { type: "boolean" }, cancelled: { type: "boolean" }, durationMs: { type: "integer", minimum: 0 },
  },
};

export function createCommandTools(policy: WorkspacePathPolicy, runner?: WorkspaceCommandRunner, captureFactory?: CommandCaptureFactory): ToolDefinition[] {
  const commandRunner = runner ?? createMacOsSandboxCommandRunner(discoverCommandExecutables(), captureFactory);
  const execute = async (input: unknown, context: ToolContext) => {
    const errors = validateCommand(policy, input);
    if (errors.length) throw new Error(`invalid_tool_input:${errors.join(",")}`);
    // Revalidation is deliberate: approval and execution can be separated by
    // arbitrary time and filesystem changes.
    return commandRunner.run(policy.canonicalRoot, input as StructuredCommandInput, context);
  };
  return ["run_command", "run_shell"].map((name) => ({
    name,
    description: `${name === "run_shell" ? "Compatibility alias for run_command. " : ""}Run an approved local validation command using executable plus exact argv (shell=false). Project code may write workspace files. Network, secrets and outside paths are denied. Supports installed bun/npm/node/python/pytest/cargo/go and local git status/rev-parse. Git content/history commands require a dedicated scoped tool to exclude secrets. Nonzero exit returns useful output; timeout/cancellation terminates the process group and reports a tool error.`,
    inputSchema, outputSchema, timeoutMs: TIMEOUT_MAX_MS,
    risk: "high", idempotency: "non_idempotent", capability: "shell", generation: 3,
    validateInput: (input: unknown) => validateCommand(policy, input), execute,
    renderOutput: (output: unknown) => JSON.stringify(output),
  }));
}
