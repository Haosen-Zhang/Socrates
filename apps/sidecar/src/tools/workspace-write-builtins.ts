/**
 * Workspace-Write Builtin Tools — Socrates Phase 1
 *
 * 提供工作区写入能力：文件创建/更新、安全删除、结构化命令执行。
 * 所有写操作需要审批（risk: high/destructive, freshHumanRequired）。
 */
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { JsonSchema, ToolContext, ToolDefinition } from "@socrates/core";
import { containsCredentialMaterial } from "../security/redaction";
import { WorkspacePathPolicy, isSecretWorkspacePath } from "../workspace/path-policy";
import { nativeWorkspaceMutationSupported } from "../workspace/native-fs";
import {
  createMacOsSandboxCommandRunner,
  type StructuredCommandInput,
  type WorkspaceCommandRunner,
} from "./workspace-command-runner";

function systemGitPath(): string {
  try {
    const developerDir = realpathSync("/var/db/xcode_select_link");
    const git = join(developerDir, "usr/bin/git");
    if (existsSync(git)) return git;
  } catch {
    // Fall through to the stable system launcher.
  }
  return "/usr/bin/git";
}

const COMMAND_PATHS = new Map([
  ["echo", "/bin/echo"],
  ["pwd", "/bin/pwd"],
  ["git", systemGitPath()],
  ["uname", "/usr/bin/uname"],
]);
const SHELL_ALLOWLIST = new Set(COMMAND_PATHS.keys());
const GIT_VALIDATION_SUBCOMMANDS = new Set(["status", "rev-parse"]);

const objectSchema = (properties: NonNullable<JsonSchema["properties"]>, required: string[]) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false as const,
});

const SHELL_METACHARACTERS = /[|;&><`\n\r\0]|\$\(/;
const OUTSIDE_PATH = /^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/])/;
const TRAVERSAL_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
const COMMAND_TIMEOUT_MAX_MS = 120_000;
const COMMAND_ARGV_MAX_ITEMS = 128;
const COMMAND_ARGV_MAX_CHARS = 8 * 1024;

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateDeleteInput(policy: WorkspacePathPolicy, input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["expected:object"];
  const path = (input as Record<string, unknown>).path;
  if (typeof path !== "string") return [];
  try {
    policy.inspectDeletionTarget(path);
    return [];
  } catch (error) {
    return [errorCode(error)];
  }
}

function validateStructuredCommand(policy: WorkspacePathPolicy, input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["expected:object"];
  const { executable, argv, timeoutMs } = input as Partial<StructuredCommandInput>;
  const errors: string[] = [];
  if (typeof executable === "string") {
    if (!SHELL_ALLOWLIST.has(executable) || executable.includes("/") || executable.includes("\\")) {
      errors.push("shell_executable_not_allowed");
    } else if (SHELL_METACHARACTERS.test(executable)) {
      errors.push("shell_metacharacter_denied");
    }
  }
  if (Array.isArray(argv)) {
    if (!argv.every((argument) => typeof argument === "string")) errors.push("shell_argv_must_be_strings");
    if (argv.length > COMMAND_ARGV_MAX_ITEMS || argv.reduce((total, argument) => (
      total + (typeof argument === "string" ? argument.length : 0)
    ), 0) > COMMAND_ARGV_MAX_CHARS) {
      errors.push("shell_argv_too_large");
    }
    for (const argument of argv) {
      if (typeof argument !== "string") continue;
      if (SHELL_METACHARACTERS.test(argument)) errors.push("shell_metacharacter_denied");
      if (containsCredentialMaterial(argument)) errors.push("shell_credential_argument_denied");
      const optionValue = argument.startsWith("-") && argument.includes("=")
        ? argument.slice(argument.indexOf("=") + 1)
        : argument.startsWith("-C") && argument.length > 2
          ? argument.slice(2)
          : argument;
      if (
        argument.startsWith("file:")
        || OUTSIDE_PATH.test(optionValue)
        || TRAVERSAL_SEGMENT.test(optionValue)
      ) {
        errors.push("shell_argument_path_outside");
      }
      const candidatePaths = [optionValue, optionValue.includes(":") ? optionValue.slice(optionValue.lastIndexOf(":") + 1) : ""]
        .filter(Boolean);
      for (const candidate of candidatePaths) {
        if (isSecretWorkspacePath(candidate)) errors.push("workspace_secret_path_denied");
        if (!candidate.startsWith("-") && existsSync(join(policy.canonicalRoot, candidate))) {
          try {
            policy.resolveExisting(candidate);
          } catch (error) {
            errors.push(errorCode(error));
          }
        }
      }
    }
    if (executable === "git" && !GIT_VALIDATION_SUBCOMMANDS.has(argv[0] ?? "")) {
      errors.push("shell_argument_not_allowed");
    }
  }
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > COMMAND_TIMEOUT_MAX_MS)) {
    errors.push("shell_timeout_invalid");
  }
  return [...new Set(errors)];
}

export function createWorkspaceWriteBuiltins(
  policy: WorkspacePathPolicy,
  commandRunner: WorkspaceCommandRunner = createMacOsSandboxCommandRunner(COMMAND_PATHS),
): ToolDefinition[] {
  if (!nativeWorkspaceMutationSupported) return [];
  return [
    {
      name: "write_file",
      description: "Create or overwrite a file in the workspace. Shows diff for existing files.",
      inputSchema: objectSchema(
        { path: { type: "string" }, content: { type: "string" } },
        ["path", "content"],
      ),
      risk: "high",
      idempotency: "non_idempotent",
      capability: "workspace_write",
      generation: 1,
      async execute(input: unknown) {
        const { path, content } = input as { path: string; content: string };
        let previousLines = 0;
        if (existsSync(policy.resolveMutationTarget(path).absolutePath)) {
          try {
            const existingText = policy.readText(path, 1024 * 1024).text;
            previousLines = existingText.split("\n").length;
          } catch (error) {
            const code = errorCode(error);
            if (code !== "workspace_binary_file" && code !== "workspace_non_utf8_file") throw error;
          }
        }
        const written = policy.writeText(path, content);

        const newLines = content.split("\n");
        return {
          action: written.existed ? "overwritten" : "created",
          path: written.relativePath,
          previousLines,
          newLines: newLines.length,
          preview: newLines.slice(0, 10).join("\n") + (newLines.length > 10 ? "\n..." : ""),
        };
      },
    },
    {
      name: "delete_path",
      description: "Delete exactly one file or one empty directory inside the workspace. Recursive deletion is never performed.",
      inputSchema: objectSchema({ path: { type: "string" } }, ["path"]),
      risk: "destructive",
      idempotency: "non_idempotent",
      capability: "workspace_write",
      generation: 1,
      validateInput(input: unknown) {
        return validateDeleteInput(policy, input);
      },
      async execute(input: unknown) {
        const validation = validateDeleteInput(policy, input);
        if (validation.length) throw new Error(`invalid_tool_input:${validation.join(",")}`);
        const { path } = input as { path: string };
        const deleted = policy.deletePath(path);
        return { action: "deleted", ...deleted };
      },
    },
    {
      name: "run_shell",
      description: "Execute one sandboxed validation command (echo, pwd, uname, git status, or git rev-parse) with an exact argv array. No shell parsing, pipes, redirects, command substitution, network, secret paths, or outside-workspace access.",
      inputSchema: objectSchema(
        {
          executable: { type: "string" },
          argv: { type: "array", items: { type: "string" } },
          timeoutMs: { type: "integer", minimum: 100, maximum: COMMAND_TIMEOUT_MAX_MS },
        },
        ["executable", "argv"],
      ),
      risk: "destructive",
      idempotency: "non_idempotent",
      capability: "shell",
      generation: 2,
      validateInput(input: unknown) {
        return validateStructuredCommand(policy, input);
      },
      async execute(input: unknown, context: ToolContext) {
        const validation = validateStructuredCommand(policy, input);
        if (validation.length) throw new Error(`invalid_tool_input:${validation.join(",")}`);
        return commandRunner.run(policy.canonicalRoot, input as StructuredCommandInput, context);
      },
    },
  ];
}
