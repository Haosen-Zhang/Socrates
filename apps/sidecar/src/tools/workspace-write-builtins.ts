/**
 * Workspace-Write Builtin Tools — Socrates Phase 1
 *
 * 提供工作区写入能力：文件创建/更新、Shell 命令执行。
 * 所有写操作需要审批（risk: high/destructive, freshHumanRequired）。
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import type { ToolDefinition } from "@socrates/core";
import { WorkspacePathPolicy } from "../workspace/path-policy";

const objectSchema = (properties: Record<string, { type: "string" | "number" | "integer" | "boolean" }>, required: string[]) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false as const,
});

export function createWorkspaceWriteBuiltins(policy: WorkspacePathPolicy): ToolDefinition[] {
  return [
    {
      name: "write_file",
      description: "Create or overwrite a file in the workspace. Always shows diff before execution.",
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
        const resolved = policy.resolveExisting(path);
        if (existsSync(resolved.absolutePath)) {
          const existingText = policy.readText(resolved.relativePath, 1024 * 1024).text;
          const newLines = content.split("\n");
          return {
            action: "overwritten",
            path: resolved.relativePath,
            previousLines: existingText.split("\n").length,
            newLines: newLines.length,
            preview: newLines.slice(0, 10).join("\n") + (newLines.length > 10 ? "\n..." : ""),
          };
        }
        mkdirSync(dirname(resolved.absolutePath), { recursive: true });
        writeFileSync(resolved.absolutePath, content, "utf-8");
        const newLines = content.split("\n");
        return {
          action: "created",
          path: resolved.relativePath,
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
