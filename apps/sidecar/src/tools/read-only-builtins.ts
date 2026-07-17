import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@socrates/core";
import { isSecretWorkspacePath, WorkspacePathPolicy } from "../workspace/path-policy";

type WalkEntry = { relativePath: string; kind: "file" | "directory" };

function walk(policy: WorkspacePathPolicy, start: string, maxEntries = 2_000): WalkEntry[] {
  const resolved = policy.resolveExisting(start || ".");
  const rootStat = lstatSync(resolved.absolutePath);
  if (!rootStat.isDirectory()) throw new Error("workspace_not_directory");
  const entries: WalkEntry[] = [];
  const queue = [{ absolute: resolved.absolutePath, relative: resolved.relativePath }];
  while (queue.length && entries.length < maxEntries) {
    const current = queue.shift()!;
    for (const name of readdirSync(current.absolute).sort()) {
      const relativePath = [current.relative, name].filter(Boolean).join("/");
      if (isSecretWorkspacePath(relativePath)) continue;
      const absolutePath = join(current.absolute, name);
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        entries.push({ relativePath, kind: "directory" });
        queue.push({ absolute: absolutePath, relative: relativePath });
      } else if (stat.isFile()) {
        entries.push({ relativePath, kind: "file" });
      }
      if (entries.length >= maxEntries) break;
    }
  }
  return entries;
}

const objectSchema = (properties: Record<string, { type: "string" | "number" | "integer" | "boolean" }>, required: string[]) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});

export function createReadOnlyBuiltins(policy: WorkspacePathPolicy): ToolDefinition[] {
  return [
    {
      name: "workspace_info", description: "Return workspace-relative root information without exposing the local absolute path",
      inputSchema: objectSchema({}, []), risk: "low", idempotency: "read", capability: "workspace_read", generation: 1,
      async execute() { return { root: ".", pathKind: "workspace_relative" }; },
    },
    {
      name: "list_directory", description: "List workspace files recursively with a bounded result count",
      inputSchema: objectSchema({ path: { type: "string" } }, ["path"]), risk: "low", idempotency: "read", capability: "workspace_read", generation: 1,
      async execute(input) {
        const { path } = input as { path: string };
        const entries = walk(policy, path).map((entry) => entry.relativePath);
        return { entries, truncated: entries.length >= 2_000 };
      },
    },
    {
      name: "search_files", description: "Search workspace file names",
      inputSchema: objectSchema({ query: { type: "string" } }, ["query"]), risk: "low", idempotency: "read", capability: "workspace_read", generation: 1,
      async execute(input) {
        const query = (input as { query: string }).query.toLowerCase();
        const matches = walk(policy, ".").filter((entry) => entry.kind === "file" && entry.relativePath.toLowerCase().includes(query)).slice(0, 200).map((entry) => entry.relativePath);
        return { matches, truncated: matches.length >= 200 };
      },
    },
    {
      name: "search_text", description: "Search bounded UTF-8 workspace text",
      inputSchema: objectSchema({ query: { type: "string" } }, ["query"]), risk: "low", idempotency: "read", capability: "workspace_read", generation: 1,
      async execute(input, context) {
        const query = (input as { query: string }).query;
        const matches: Array<{ path: string; line: number; text: string }> = [];
        for (const entry of walk(policy, ".")) {
          if (context.signal.aborted) throw new Error("tool_cancelled");
          if (entry.kind !== "file") continue;
          try {
            const { text } = policy.readText(entry.relativePath, 512 * 1024);
            text.split("\n").forEach((line, index) => {
              if (matches.length < 200 && line.includes(query)) matches.push({ path: entry.relativePath, line: index + 1, text: line.slice(0, 500) });
            });
          } catch {
            // Binary, secret, changed and oversized files are omitted rather than bypassing policy.
          }
          if (matches.length >= 200) break;
        }
        return { matches, truncated: matches.length >= 200 };
      },
    },
    {
      name: "read_file", description: "Read a bounded UTF-8 workspace file",
      inputSchema: objectSchema({ path: { type: "string" } }, ["path"]), risk: "low", idempotency: "read", capability: "workspace_read", generation: 1,
      async execute(input) { return policy.readText((input as { path: string }).path, 512 * 1024); },
    },
  ];
}
