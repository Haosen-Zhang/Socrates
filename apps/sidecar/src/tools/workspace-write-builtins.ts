/**
 * Workspace-Write Builtin Tools — Socrates Phase 1
 *
 * 提供工作区写入能力：文件创建/更新、安全删除、结构化命令执行。
 * 所有写操作需要审批（risk: high/destructive, freshHumanRequired）。
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { JsonSchema, ToolContext, ToolDefinition } from "@socrates/core";
import { Document, HeadingLevel, Packer, Paragraph } from "docx";
import ExcelJS from "exceljs";
import { zipSync } from "fflate";
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
const TREE_MAX_ENTRIES = 256;
const TREE_MAX_BYTES = 50 * 1024 * 1024;
const DOC_MAX_PARAGRAPHS = 1_000;
const DOC_MAX_BYTES = 1024 * 1024;
const SHEET_MAX_COUNT = 10;
const SHEET_MAX_ROWS = 5_000;
const SHEET_MAX_COLUMNS = 100;
const SHEET_MAX_CELLS = 50_000;
const SHEET_MAX_BYTES = 5 * 1024 * 1024;
const FORMULA_PREFIX = /^[\u0000-\u0020]*[=+\-@]/;

type CellValue = string | number | boolean | null;
type SheetInput = { name: string; rows: CellValue[][] };

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

function validatePathPair(
  policy: WorkspacePathPolicy,
  input: unknown,
  destructive = false,
): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["expected:object"];
  const { source, destination } = input as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof source === "string") {
    if (isSecretWorkspacePath(source)) errors.push("workspace_secret_path_denied");
    try {
      policy.resolveExisting(source);
    } catch (error) {
      errors.push(errorCode(error));
    }
  }
  if (typeof destination === "string") {
    try {
      const resolved = policy.resolveMutationTarget(destination);
      if (existsSync(resolved.absolutePath)) errors.push("workspace_path_changed");
      if (destructive && resolved.relativePath.startsWith(`${String(source)}/`)) {
        errors.push("workspace_move_into_self");
      }
    } catch (error) {
      errors.push(errorCode(error));
    }
  }
  return [...new Set(errors)];
}

function validateArchiveInput(policy: WorkspacePathPolicy, input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["expected:object"];
  const { path, sources } = input as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof path === "string") {
    try {
      const target = policy.resolveMutationTarget(path);
      if (extname(target.relativePath).toLowerCase() !== ".zip") errors.push("archive_extension_invalid");
      if (existsSync(target.absolutePath)) errors.push("workspace_path_changed");
    } catch (error) {
      errors.push(errorCode(error));
    }
  }
  if (Array.isArray(sources)) {
    if (sources.length < 1 || sources.length > 32) errors.push("archive_sources_invalid");
    for (const source of sources) {
      if (typeof source !== "string") continue;
      if (isSecretWorkspacePath(source)) errors.push("workspace_secret_path_denied");
      try {
        policy.resolveExisting(source);
      } catch (error) {
        errors.push(errorCode(error));
      }
    }
  }
  return [...new Set(errors)];
}

function validateDocumentInput(policy: WorkspacePathPolicy, input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["expected:object"];
  const { path, title, paragraphs } = input as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof path === "string") {
    try {
      const target = policy.resolveMutationTarget(path);
      if (extname(target.relativePath).toLowerCase() !== ".docx") errors.push("document_extension_invalid");
      if (existsSync(target.absolutePath)) errors.push("workspace_path_changed");
    } catch (error) {
      errors.push(errorCode(error));
    }
  }
  if (title !== undefined && typeof title !== "string") errors.push("document_title_invalid");
  if (Array.isArray(paragraphs)) {
    if (paragraphs.length > DOC_MAX_PARAGRAPHS || !paragraphs.every((item) => typeof item === "string")) {
      errors.push("document_paragraphs_invalid");
    } else if (
      Buffer.byteLength(typeof title === "string" ? title : "", "utf-8")
        + paragraphs.reduce((total, item) => total + Buffer.byteLength(String(item), "utf-8"), 0)
      > DOC_MAX_BYTES
    ) {
      errors.push("document_too_large");
    }
  }
  return [...new Set(errors)];
}

function parseSheets(value: unknown): { sheets: SheetInput[]; errors: string[] } {
  if (!Array.isArray(value) || value.length < 1 || value.length > SHEET_MAX_COUNT) {
    return { sheets: [], errors: ["spreadsheet_sheets_invalid"] };
  }
  const errors: string[] = [];
  const sheets: SheetInput[] = [];
  let cells = 0;
  let bytes = 0;
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push("spreadsheet_sheet_invalid");
      continue;
    }
    const { name, rows } = raw as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim() || name.length > 31 || /[\\/?*:[\]]/.test(name)) {
      errors.push("spreadsheet_sheet_name_invalid");
    }
    if (typeof name === "string") bytes += Buffer.byteLength(name, "utf-8");
    if (!Array.isArray(rows) || rows.length > SHEET_MAX_ROWS) {
      errors.push("spreadsheet_rows_invalid");
      continue;
    }
    const parsedRows: CellValue[][] = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length > SHEET_MAX_COLUMNS) {
        errors.push("spreadsheet_columns_invalid");
        continue;
      }
      const parsed: CellValue[] = [];
      for (const cell of row) {
        if (cell !== null && !["string", "number", "boolean"].includes(typeof cell)) {
          errors.push("spreadsheet_cell_invalid");
          continue;
        }
        if (typeof cell === "number" && !Number.isFinite(cell)) errors.push("spreadsheet_cell_invalid");
        if (typeof cell === "string") {
          bytes += Buffer.byteLength(cell, "utf-8");
          if (FORMULA_PREFIX.test(cell)) errors.push("spreadsheet_formula_denied");
        }
        parsed.push(cell as CellValue);
        cells += 1;
      }
      parsedRows.push(parsed);
    }
    sheets.push({ name: typeof name === "string" ? name : "", rows: parsedRows });
  }
  if (cells > SHEET_MAX_CELLS) errors.push("spreadsheet_too_large");
  if (bytes > SHEET_MAX_BYTES) errors.push("spreadsheet_too_large");
  return { sheets, errors: [...new Set(errors)] };
}

function validateSpreadsheetInput(policy: WorkspacePathPolicy, input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["expected:object"];
  const { path, format, sheets } = input as Record<string, unknown>;
  const errors: string[] = [];
  if (format !== "xlsx" && format !== "csv") errors.push("spreadsheet_format_invalid");
  if (typeof path === "string") {
    try {
      const target = policy.resolveMutationTarget(path);
      if (extname(target.relativePath).toLowerCase() !== `.${String(format)}`) {
        errors.push("spreadsheet_extension_invalid");
      }
      if (existsSync(target.absolutePath)) errors.push("workspace_path_changed");
    } catch (error) {
      errors.push(errorCode(error));
    }
  }
  const parsed = parseSheets(sheets);
  errors.push(...parsed.errors);
  if (format === "csv" && parsed.sheets.length !== 1) errors.push("spreadsheet_csv_single_sheet");
  return [...new Set(errors)];
}

function csvValue(value: CellValue): string {
  if (value === null) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
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
      name: "create_directory",
      description: "Create a directory and any missing parent directories inside the workspace. Existing targets are never overwritten.",
      inputSchema: objectSchema({ path: { type: "string" } }, ["path"]),
      risk: "high",
      idempotency: "non_idempotent",
      capability: "workspace_write",
      generation: 1,
      validateInput(input: unknown) {
        if (!input || typeof input !== "object" || Array.isArray(input)) return ["expected:object"];
        const path = (input as Record<string, unknown>).path;
        if (typeof path !== "string") return [];
        try {
          const target = policy.resolveMutationTarget(path);
          return existsSync(target.absolutePath) ? ["workspace_path_changed"] : [];
        } catch (error) {
          return [errorCode(error)];
        }
      },
      async execute(input: unknown) {
        const { path } = input as { path: string };
        return { action: "created", kind: "directory", ...policy.createDirectory(path) };
      },
    },
    {
      name: "copy_path",
      description: "Copy one file or a bounded directory tree inside the workspace. Symlinks, hardlinks, secret paths, oversized trees, and overwrites are denied.",
      inputSchema: objectSchema(
        { source: { type: "string" }, destination: { type: "string" } },
        ["source", "destination"],
      ),
      risk: "high",
      idempotency: "non_idempotent",
      capability: "workspace_write",
      generation: 1,
      validateInput(input: unknown) {
        return validatePathPair(policy, input);
      },
      async execute(input: unknown) {
        const validation = validatePathPair(policy, input);
        if (validation.length) throw new Error(`invalid_tool_input:${validation.join(",")}`);
        const { source, destination } = input as { source: string; destination: string };
        const snapshot = policy.snapshotTree(source, {
          maxEntries: TREE_MAX_ENTRIES,
          maxBytes: TREE_MAX_BYTES,
        });
        if (snapshot.kind === "file") {
          const file = snapshot.entries[0];
          if (!file || file.kind !== "file") throw new Error("workspace_tree_invalid");
          policy.createFile(destination, file.bytes);
        } else {
          policy.createTree(destination, snapshot);
        }
        return {
          action: "copied",
          source: policy.resolveExisting(source).relativePath,
          destination: policy.resolveExisting(destination).relativePath,
          kind: snapshot.kind,
          entries: snapshot.entries.length,
          byteSize: snapshot.totalBytes,
        };
      },
    },
    {
      name: "move_path",
      description: "Move or rename one file or directory inside the workspace without overwriting the destination.",
      inputSchema: objectSchema(
        { source: { type: "string" }, destination: { type: "string" } },
        ["source", "destination"],
      ),
      risk: "destructive",
      idempotency: "non_idempotent",
      capability: "workspace_write",
      generation: 1,
      validateInput(input: unknown) {
        return validatePathPair(policy, input, true);
      },
      async execute(input: unknown) {
        const validation = validatePathPair(policy, input, true);
        if (validation.length) throw new Error(`invalid_tool_input:${validation.join(",")}`);
        const { source, destination } = input as { source: string; destination: string };
        return { action: "moved", ...policy.movePath(source, destination) };
      },
    },
    {
      name: "create_archive",
      description: "Create a bounded ZIP archive from workspace files or directories. Archive extraction and overwrites are not supported.",
      inputSchema: objectSchema(
        {
          path: { type: "string" },
          sources: { type: "array", items: { type: "string" } },
        },
        ["path", "sources"],
      ),
      risk: "high",
      idempotency: "non_idempotent",
      capability: "workspace_write",
      generation: 1,
      validateInput(input: unknown) {
        return validateArchiveInput(policy, input);
      },
      async execute(input: unknown) {
        const validation = validateArchiveInput(policy, input);
        if (validation.length) throw new Error(`invalid_tool_input:${validation.join(",")}`);
        const { path, sources } = input as { path: string; sources: string[] };
        const archiveEntries: Record<string, Uint8Array> = {};
        const rootNames = new Set<string>();
        let entryCount = 0;
        let totalBytes = 0;
        for (const source of sources) {
          const resolved = policy.resolveExisting(source);
          const rootName = basename(resolved.relativePath);
          if (rootNames.has(rootName)) throw new Error("archive_source_name_collision");
          rootNames.add(rootName);
          const snapshot = policy.snapshotTree(source, {
            maxEntries: TREE_MAX_ENTRIES - entryCount,
            maxBytes: TREE_MAX_BYTES - totalBytes,
          });
          totalBytes += snapshot.totalBytes;
          if (snapshot.kind === "file") {
            const entry = snapshot.entries[0];
            if (!entry || entry.kind !== "file") throw new Error("workspace_tree_invalid");
            archiveEntries[rootName] = entry.bytes;
            entryCount += 1;
          } else {
            if (snapshot.entries.length === 0) {
              entryCount += 1;
              if (entryCount > TREE_MAX_ENTRIES) throw new Error("workspace_tree_too_many_entries");
              archiveEntries[`${rootName}/`] = new Uint8Array();
            }
            for (const entry of snapshot.entries) {
              archiveEntries[`${rootName}/${entry.path}${entry.kind === "directory" ? "/" : ""}`] =
                entry.kind === "directory" ? new Uint8Array() : entry.bytes;
              entryCount += 1;
            }
          }
        }
        const compressed = zipSync(archiveEntries, { level: 6 });
        const written = policy.createFile(path, compressed);
        return {
          action: "created",
          format: "zip",
          path: written.path,
          entries: entryCount,
          sourceBytes: totalBytes,
          byteSize: written.byteSize,
        };
      },
    },
    {
      name: "create_document",
      description: "Create a DOCX document from a title and plain-text paragraphs. Existing files and hidden model reasoning are never included.",
      inputSchema: objectSchema(
        {
          path: { type: "string" },
          title: { type: "string" },
          paragraphs: { type: "array", items: { type: "string" } },
        },
        ["path", "paragraphs"],
      ),
      risk: "high",
      idempotency: "non_idempotent",
      capability: "workspace_write",
      generation: 1,
      validateInput(input: unknown) {
        return validateDocumentInput(policy, input);
      },
      async execute(input: unknown) {
        const validation = validateDocumentInput(policy, input);
        if (validation.length) throw new Error(`invalid_tool_input:${validation.join(",")}`);
        const { path, title, paragraphs } = input as {
          path: string;
          title?: string;
          paragraphs: string[];
        };
        const children = [
          ...(title ? [new Paragraph({ text: title, heading: HeadingLevel.TITLE })] : []),
          ...paragraphs.map((text) => new Paragraph({ text })),
        ];
        const bytes = await Packer.toBuffer(new Document({ sections: [{ children }] }));
        const written = policy.createFile(path, bytes);
        return {
          action: "created",
          format: "docx",
          path: written.path,
          paragraphs: paragraphs.length,
          byteSize: written.byteSize,
        };
      },
    },
    {
      name: "create_spreadsheet",
      description: "Create an XLSX workbook or one-sheet CSV from bounded structured rows. Formulas, macros, and overwrites are denied.",
      inputSchema: objectSchema(
        {
          path: { type: "string" },
          format: { type: "string" },
          sheets: { type: "array", items: { type: "object" } },
        },
        ["path", "format", "sheets"],
      ),
      risk: "high",
      idempotency: "non_idempotent",
      capability: "workspace_write",
      generation: 1,
      validateInput(input: unknown) {
        return validateSpreadsheetInput(policy, input);
      },
      async execute(input: unknown) {
        const validation = validateSpreadsheetInput(policy, input);
        if (validation.length) throw new Error(`invalid_tool_input:${validation.join(",")}`);
        const { path, format } = input as { path: string; format: "xlsx" | "csv" };
        const { sheets } = parseSheets((input as Record<string, unknown>).sheets);
        let bytes: Uint8Array;
        if (format === "csv") {
          bytes = Buffer.from(
            `${sheets[0]!.rows.map((row) => row.map(csvValue).join(",")).join("\r\n")}\r\n`,
            "utf-8",
          );
        } else {
          const workbook = new ExcelJS.Workbook();
          workbook.creator = "Socrates";
          for (const sheet of sheets) {
            const worksheet = workbook.addWorksheet(sheet.name);
            for (const row of sheet.rows) worksheet.addRow(row);
          }
          bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
        }
        const written = policy.createFile(path, bytes);
        return {
          action: "created",
          format,
          path: written.path,
          sheets: sheets.length,
          rows: sheets.reduce((total, sheet) => total + sheet.rows.length, 0),
          byteSize: written.byteSize,
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
