import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { JsonSchema, ToolDefinition } from "@socrates/core";
import { isSecretWorkspacePath, WorkspacePathPolicy } from "../workspace/path-policy";

type WalkEntry = { relativePath: string; kind: "file" | "directory" };
type Coverage = {
  traversalTruncated: boolean;
  entriesScanned: number;
  filesScanned: number;
  fileContentTruncated: number;
  binaryFilesSkipped: number;
  unsupportedFilesSkipped: number;
  skippedEntries: number;
  matchTextTruncated: number;
};

const integer: JsonSchema = { type: "integer", minimum: 0 };
const flag: JsonSchema = { type: "boolean" };
const text: JsonSchema = { type: "string" };
const pathSchema: JsonSchema = { type: "string", description: "Workspace-relative path; absolute paths and secret paths are denied.", minLength: 1 };
const objectSchema = (properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
const coverageSchema = objectSchema({
  traversalTruncated: { ...flag, description: "Traversal stopped before all eligible entries were inspected (2000-entry limit)." },
  entriesScanned: { ...integer, description: "Filesystem entries examined, including excluded entries and the lookahead entry at the traversal limit." },
  filesScanned: { ...integer, description: "Eligible file names examined or text reads attempted, including failed reads." },
  fileContentTruncated: { ...integer, description: "Files searched only through their first 512 KiB." },
  binaryFilesSkipped: integer,
  unsupportedFilesSkipped: { ...integer, description: "Non-UTF8 files skipped." },
  skippedEntries: { ...integer, description: "Secret paths, symlinks, non-files and failed filesystem operations omitted." },
  matchTextTruncated: { ...integer, description: "Returned matching lines with a preview clipped to 500 characters." },
});
const resultFields = {
  coverage: coverageSchema,
  resultTruncated: { ...flag, description: "At least one matching result was omitted after the 200-result limit; independent of traversal coverage." },
  truncated: { ...flag, description: "Any result, traversal, file content or matching-line preview was truncated, or an entry was skipped. Inspect coverage before concluding absence." },
};

function cancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new Error("tool_cancelled"); }

function walk(policy: WorkspacePathPolicy, start: string, signal?: AbortSignal): { entries: WalkEntry[]; coverage: Coverage } {
  const resolved = policy.resolveExisting(start || ".");
  if (!lstatSync(resolved.absolutePath).isDirectory()) throw new Error("workspace_not_directory");
  const entries: WalkEntry[] = [];
  const coverage: Coverage = { traversalTruncated: false, entriesScanned: 0, filesScanned: 0, fileContentTruncated: 0, binaryFilesSkipped: 0, unsupportedFilesSkipped: 0, skippedEntries: 0, matchTextTruncated: 0 };
  const queue = [resolved.relativePath];
  while (queue.length) {
    cancelled(signal);
    const current = queue.shift()!;
    let names: string[];
    try { names = readdirSync(policy.resolveExisting(current || ".").absolutePath).sort(); }
    catch { coverage.skippedEntries++; continue; }
    for (const name of names) {
      cancelled(signal);
      coverage.entriesScanned++;
      const relativePath = [current, name].filter(Boolean).join("/");
      if (isSecretWorkspacePath(relativePath)) { coverage.skippedEntries++; continue; }
      let stat;
      try { stat = lstatSync(join(policy.canonicalRoot, relativePath)); }
      catch { coverage.skippedEntries++; continue; }
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) { coverage.skippedEntries++; continue; }
      // One eligible lookahead distinguishes exactly full traversal from truncation.
      if (entries.length === 2_000) { coverage.traversalTruncated = true; return { entries, coverage }; }
      const kind = stat.isDirectory() ? "directory" : "file";
      entries.push({ relativePath, kind });
      if (kind === "directory") queue.push(relativePath);
    }
  }
  return { entries, coverage };
}

function incomplete(coverage: Coverage, resultTruncated: boolean): boolean {
  return resultTruncated || coverage.traversalTruncated || coverage.fileContentTruncated > 0
    || coverage.skippedEntries > 0 || coverage.binaryFilesSkipped > 0 || coverage.unsupportedFilesSkipped > 0 || coverage.matchTextTruncated > 0;
}

export function createReadOnlyBuiltins(policy: WorkspacePathPolicy): ToolDefinition[] {
  const metadata = { risk: "low", idempotency: "read", capability: "workspace_read", generation: 2, timeoutMs: 30_000 } as const;
  return [
    {
      ...metadata,
      name: "workspace_info", description: "Return the workspace-relative root marker without exposing the local absolute path.",
      inputSchema: objectSchema({}), outputSchema: objectSchema({ root: { ...text, enum: ["."] }, pathKind: { ...text, enum: ["workspace_relative"] } }),
      async execute(_input, context) { cancelled(context.signal); return { root: ".", pathKind: "workspace_relative" }; },
    },
    {
      ...metadata,
      name: "list_directory", description: "Recursively list at most 2000 workspace files/directories, excluding secret paths and symlinks. Inspect coverage for omitted entries.",
      inputSchema: objectSchema({ path: { ...pathSchema, description: "Workspace-relative directory; use '.' for the workspace root." } }),
      outputSchema: objectSchema({ entries: { type: "array", items: pathSchema }, ...resultFields }),
      async execute(input, context) {
        const { entries, coverage } = walk(policy, (input as { path: string }).path, context.signal);
        coverage.filesScanned = entries.filter((entry) => entry.kind === "file").length;
        return { entries: entries.map((entry) => entry.relativePath), coverage, resultTruncated: false, truncated: incomplete(coverage, false) };
      },
    },
    {
      ...metadata,
      name: "search_files", description: "Case-insensitive substring search of workspace-relative file paths, bounded to 2000 traversed entries and 200 matches. Empty results apply only to reported coverage.",
      inputSchema: objectSchema({ query: { ...text, description: "Case-insensitive literal substring of a file path; empty matches every eligible file." } }),
      outputSchema: objectSchema({ matches: { type: "array", items: pathSchema, maxItems: 200 }, ...resultFields }),
      async execute(input, context) {
        const query = (input as { query: string }).query.toLowerCase();
        const { entries, coverage } = walk(policy, ".", context.signal);
        const allMatches: string[] = [];
        for (const entry of entries) {
          cancelled(context.signal);
          if (entry.kind !== "file") continue;
          coverage.filesScanned++;
          if (entry.relativePath.toLowerCase().includes(query)) allMatches.push(entry.relativePath);
        }
        const resultTruncated = allMatches.length > 200;
        return { matches: allMatches.slice(0, 200), coverage, resultTruncated, truncated: incomplete(coverage, resultTruncated) };
      },
    },
    {
      ...metadata,
      name: "search_text", description: "Case-sensitive literal UTF-8 line search: 2000 traversed entries, 512 KiB per file, 200 results, 500 characters per preview. Inspect coverage before concluding a query is absent.",
      inputSchema: objectSchema({ query: { ...text, description: "Case-sensitive literal substring; no regex. Empty matches every line." } }),
      outputSchema: objectSchema({ matches: { type: "array", maxItems: 200, items: objectSchema({ path: pathSchema, line: { type: "integer", minimum: 1 }, text, textTruncated: flag }) }, ...resultFields }),
      async execute(input, context) {
        const query = (input as { query: string }).query;
        const { entries, coverage } = walk(policy, ".", context.signal);
        const matches: Array<{ path: string; line: number; text: string; textTruncated: boolean }> = [];
        let resultTruncated = false;
        for (const entry of entries) {
          cancelled(context.signal);
          if (entry.kind !== "file") continue;
          coverage.filesScanned++;
          try {
            const file = policy.readText(entry.relativePath, 512 * 1024);
            if (file.truncated) coverage.fileContentTruncated++;
            for (const [index, line] of file.text.split("\n").entries()) {
              cancelled(context.signal);
              if (!line.includes(query)) continue;
              if (matches.length === 200) { resultTruncated = true; continue; }
              const textTruncated = line.length > 500;
              if (textTruncated) coverage.matchTextTruncated++;
              matches.push({ path: entry.relativePath, line: index + 1, text: line.slice(0, 500), textTruncated });
            }
          } catch (error) {
            cancelled(context.signal);
            const code = error instanceof Error ? error.message : String(error);
            if (code === "workspace_binary_file") coverage.binaryFilesSkipped++;
            else if (code === "workspace_non_utf8_file") coverage.unsupportedFilesSkipped++;
            else coverage.skippedEntries++;
          }
        }
        return { matches, coverage, resultTruncated, truncated: incomplete(coverage, resultTruncated) };
      },
    },
    {
      ...metadata,
      name: "read_file", description: "Read the first 512 KiB of a UTF-8 workspace file. Returns the original byte size and SHA-256 of the entire file; truncation applies only to text.",
      inputSchema: objectSchema({ path: pathSchema }),
      outputSchema: objectSchema({ path: pathSchema, text, byteSize: integer, sha256: { ...text, pattern: "^[a-f0-9]{64}$" }, truncated: flag }),
      async execute(input, context) {
        cancelled(context.signal);
        const { path, text, byteSize, sha256, truncated } = policy.readText((input as { path: string }).path, 512 * 1024);
        return { path, text, byteSize, sha256, truncated };
      },
    },
  ];
}
