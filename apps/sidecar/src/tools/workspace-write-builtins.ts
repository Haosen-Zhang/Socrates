/**
 * Workspace-Write Builtin Tools — Socrates Phase 1
 *
 * 提供工作区写入能力：文件创建/更新、Shell 命令执行。
 * 所有写操作需要审批（risk: high/destructive, freshHumanRequired）。
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { execFileSync } from "node:child_process";
import type { ToolDefinition } from "@socrates/core";
import { normalizeWorkspaceRelativePath } from "@socrates/core";
import { WorkspacePathPolicy } from "../workspace/path-policy";

const objectSchema = (properties: Record<string, { type: "string" | "number" | "integer" | "boolean" }>, required: string[]) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false as const,
});

/** Resolve a path for writing — the target file may not exist yet */
function resolveForWrite(policy: WorkspacePathPolicy, input: string): { absolutePath: string; relativePath: string } {
  const relativePath = normalizeWorkspaceRelativePath(input);
  const lexical = join(policy.canonicalRoot, relativePath);
  if (!lexical.startsWith(policy.canonicalRoot + "/") && lexical !== policy.canonicalRoot) {
    throw new Error("workspace_path_escape");
  }
  return { absolutePath: normalize(lexical), relativePath };
}

export function createWorkspaceWriteBuiltins(policy: WorkspacePathPolicy): ToolDefinition[] {
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
        const resolved = resolveForWrite(policy, path);
        const existed = existsSync(resolved.absolutePath);
        let previousLines = 0;

        if (existed) {
          try {
            const existingText = policy.readText(resolved.relativePath, 1024 * 1024).text;
            previousLines = existingText.split("\n").length;
          } catch {
            // Non-text file — overwrite anyway
          }
        }

        mkdirSync(dirname(resolved.absolutePath), { recursive: true });
        writeFileSync(resolved.absolutePath, content, "utf-8");

        const newLines = content.split("\n");
        return {
          action: existed ? "overwritten" : "created",
          path: resolved.relativePath,
          previousLines,
          newLines: newLines.length,
          preview: newLines.slice(0, 10).join("\n") + (newLines.length > 10 ? "\n..." : ""),
        };
      },
    },
    {
      name: "run_shell",
      description: "Execute a shell command inside the workspace. Output is truncated. Non-interactive only.",
      inputSchema: objectSchema(
        { command: { type: "string" }, args: { type: "string" } },
        ["command"],
      ),
      risk: "destructive",
      idempotency: "non_idempotent",
      capability: "workspace_write",
      generation: 1,
      async execute(input: unknown) {
        const { command, args } = input as { command: string; args?: string };
        const argList = args ? args.split(/\s+/) : [];
        try {
          const stdout = execFileSync(command, argList, {
            cwd: policy.canonicalRoot,
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
            encoding: "utf-8",
          });
          const lines = stdout.split("\n");
          const truncated = lines.length > 500;
          return {
            exitCode: 0,
            stdout: lines.slice(0, 500).join("\n") + (truncated ? "\n[output truncated]" : ""),
            truncated,
          };
        } catch (err: any) {
          return {
            exitCode: err.status ?? 1,
            stdout: (err.stdout ?? "").toString().slice(0, 50_000),
            stderr: (err.stderr ?? err.message ?? "unknown error").toString().slice(0, 10_000),
          };
        }
      },
    },
  ];
}
