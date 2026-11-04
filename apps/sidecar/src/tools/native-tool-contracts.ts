import type { JsonSchema, JsonSchemaValue, ToolDefinition } from "@socrates/core";

const string: JsonSchema = { type: "string" };
const integer: JsonSchema = { type: "integer", minimum: 0 };
const path: JsonSchema = { type: "string", minLength: 1, description: "Workspace-relative path. Absolute paths, parent traversal, secret paths and symlinks are denied." };
const hash: JsonSchema = { type: "string", pattern: "^[a-f0-9]{64}$", description: "SHA-256 of the complete file bytes, as 64 lowercase hexadecimal characters." };
const kind: JsonSchema = { type: "string", enum: ["file", "directory"] };
const object = (properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
const action = (name: string): JsonSchema => ({ type: "string", enum: [name] });
const withExample = (schema: JsonSchema, example: JsonSchemaValue): JsonSchema => ({ ...schema, examples: [example] });
type Contract = Pick<ToolDefinition, "description" | "inputSchema" | "outputSchema" | "timeoutMs">;

const contracts: Record<string, Contract> = {
  write_file: {
    description: "Atomically create or overwrite a UTF-8 workspace file. Returns complete before/after SHA-256 and a bounded unified diff. Supply expectedSha256 to reject stale updates.",
    inputSchema: withExample(object({
      path,
      content: { type: "string", description: "Complete replacement UTF-8 text, not a patch." },
      expectedSha256: { ...hash, description: "Optional SHA-256 of the existing full file. A mismatch rejects the update; omission permits the approved overwrite." },
    }, ["path", "content"]), { path: "notes.txt", content: "Updated notes\n" }),
    outputSchema: object({ action: { type: "string", enum: ["created", "overwritten"] }, path, oldSha256: { anyOf: [hash, { type: "null" }], description: "Full previous file hash, or null for a new file." }, newSha256: hash, diff: { ...string, description: "Bounded unified diff of the approved change." }, diffTruncated: { type: "boolean" } }),
    timeoutMs: 30_000,
  },
  create_directory: {
    description: "Create a workspace directory and missing parents. An existing target is rejected.",
    inputSchema: object({ path: { ...path, description: "Workspace-relative new directory; existing target is rejected." } }),
    outputSchema: object({ action: action("created"), kind: { type: "string", enum: ["directory"] }, path }),
    timeoutMs: 30_000,
  },
  copy_path: {
    description: "Copy a workspace file or bounded directory tree to a new destination: at most 256 entries and 50 MiB. Symlinks, hardlinks, secret paths and overwrites are denied.",
    inputSchema: withExample(object({ source: { ...path, description: "Existing workspace-relative file or directory to copy." }, destination: { ...path, description: "New workspace-relative destination; must not exist." } }), { source: "src", destination: "src-copy" }),
    outputSchema: object({ action: action("copied"), source: path, destination: path, kind, entries: integer, byteSize: integer }),
    timeoutMs: 30_000,
  },
  move_path: {
    description: "Move or rename one workspace file or directory to a new destination without overwriting. Moving a directory into itself is denied.",
    inputSchema: withExample(object({ source: { ...path, description: "Existing workspace-relative file or directory." }, destination: { ...path, description: "New workspace-relative destination; must not exist." } }), { source: "draft.txt", destination: "final.txt" }),
    outputSchema: object({ action: action("moved"), from: path, to: path, kind }),
    timeoutMs: 30_000,
  },
  create_archive: {
    description: "Create a new ZIP from 1–32 workspace sources, bounded to 256 entries and 50 MiB before compression. Extraction, duplicate source root names and overwrites are denied.",
    inputSchema: withExample(object({ path: { ...path, description: "New workspace-relative .zip filename; must not exist." }, sources: { type: "array", minItems: 1, maxItems: 32, items: path, description: "Existing workspace-relative files/directories; source basenames must be unique." } }), { path: "report.zip", sources: ["report.txt"] }),
    outputSchema: object({ action: action("created"), format: action("zip"), path, entries: integer, sourceBytes: integer, byteSize: integer }),
    timeoutMs: 30_000,
  },
  create_document: {
    description: "Create a new DOCX from an optional title and plain-text paragraphs (at most 1000 paragraphs, 1 MiB combined UTF-8 text). Existing destinations are rejected.",
    inputSchema: withExample(object({ path: { ...path, description: "New workspace-relative .docx filename; must not exist." }, title: { type: "string", description: "Optional visible document title; plain text." }, paragraphs: { type: "array", maxItems: 1_000, items: { type: "string", description: "One visible plain-text paragraph." }, description: "Ordered paragraph strings; combined title and paragraphs must fit 1 MiB UTF-8." } }, ["path", "paragraphs"]), { path: "report.docx", title: "Report", paragraphs: ["Summary of results."] }),
    outputSchema: object({ action: action("created"), format: action("docx"), path, paragraphs: integer, byteSize: integer }),
    timeoutMs: 30_000,
  },
  create_spreadsheet: {
    description: "Create a new XLSX or one-sheet CSV from typed cells. Limits: 10 sheets, 5000 rows/sheet, 100 columns/row, 50000 total cells and 5 MiB text. Formula-like strings, macros and overwrites are denied.",
    inputSchema: withExample(object({
      path: { ...path, description: "New workspace-relative filename whose .xlsx/.csv extension matches format; must not exist." },
      format: { type: "string", enum: ["xlsx", "csv"], description: "XLSX supports multiple sheets; CSV requires exactly one sheet." },
      sheets: { type: "array", minItems: 1, maxItems: 10, description: "Ordered worksheets. Sheet names must be unique, nonblank and use valid Excel characters.", items: object({
        name: { type: "string", minLength: 1, maxLength: 31, pattern: "^[^\\\\/?*:\\[\\]]+$", description: "Nonblank Excel worksheet name, at most 31 characters; unique across sheets." },
        rows: { type: "array", maxItems: 5_000, description: "Ordered rows, including any header row; at most 50000 total cells across sheets.", items: { type: "array", maxItems: 100, description: "Up to 100 scalar cells. Null becomes an empty cell.", items: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }], description: "Literal string, finite number, boolean or null. Strings beginning with =, +, -, @ after whitespace are rejected as formula-like." } } },
      }) },
    }), { path: "results.xlsx", format: "xlsx", sheets: [{ name: "Results", rows: [["Item", "Count"], ["A", 3], ["B", null]] }] }),
    outputSchema: object({ action: action("created"), format: { type: "string", enum: ["xlsx", "csv"] }, path, sheets: integer, rows: integer, byteSize: integer }),
    timeoutMs: 30_000,
  },
  delete_path: {
    description: "Delete exactly one workspace file or one empty directory. Nonempty directories and recursive deletion are rejected.",
    inputSchema: object({ path: { ...path, description: "Existing workspace-relative file or empty directory to delete; never recursive." } }),
    outputSchema: object({ action: action("deleted"), path, kind }),
    timeoutMs: 30_000,
  },
};

/** Add model-facing contracts without replacing bodies, policy validators or approval metadata.
 * Command tools carry their own contracts. MCP and unknown tools remain untouched.
 */
export function applyNativeToolContracts(definitions: ToolDefinition[]): ToolDefinition[] {
  return definitions.map((definition) => {
    const contract = definition.capability === "workspace_write" ? contracts[definition.name] : undefined;
    return contract ? { ...definition, ...contract } : definition;
  });
}
