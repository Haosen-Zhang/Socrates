import type { StructuredPlan } from "./plan";

/** Scope checks classify approvals; the native path and command policies still
 * validate capabilities, symlinks, secrets and concrete side-effect permission. */
export function toolWithinPlanScope(plan: StructuredPlan, call: { name: string; input: unknown }): boolean {
  if (!call.input || typeof call.input !== "object" || Array.isArray(call.input)) return false;
  const input = call.input as Record<string, unknown>;
  if (["run_command", "run_shell", "shell_command"].includes(call.name)) {
    const cwd = relativePath(input.cwd ?? ".");
    if (cwd === null) return false;
    const actual = call.name === "shell_command"
      ? (typeof input.command === "string" ? parseCommand(input.command, cwd) : null)
      : (typeof input.executable === "string" && Array.isArray(input.argv) && input.argv.every((arg) => typeof arg === "string")
        ? { cwd, argv: [input.executable, ...input.argv as string[]] } : null);
    if (!actual) return false;
    return plan.steps.flatMap((step) => step.commands).some((command) => {
      const declared = parseCommand(command);
      return declared !== null && declared.cwd === actual.cwd && declared.argv.length === actual.argv.length
        && declared.argv.every((arg, index) => arg === actual.argv[index]);
    });
  }
  const pathFields: Record<string, string[]> = {
    file_change: ["path"], write_file: ["path"], edit_file: ["path"],
    create_directory: ["path"], delete_path: ["path"], create_document: ["path"], create_spreadsheet: ["path"],
    copy_path: ["source", "destination"], move_path: ["source", "destination"], create_archive: ["path"],
  };
  const fields = pathFields[call.name];
  if (!Object.prototype.hasOwnProperty.call(pathFields, call.name)) return false;
  const paths: unknown[] = fields.map((field) => input[field]);
  if (call.name === "create_archive") {
    if (!Array.isArray(input.sources) || !input.sources.length) return false;
    paths.push(...input.sources);
  }
  const files = new Set([
    ...plan.steps.flatMap((step) => step.files),
    ...(plan.workPackages ?? []).flatMap((item) => item.expectedFiles),
  ].map(relativePath).filter((path): path is string => path !== null && path !== "."));
  return paths.length > 0 && paths.every((path) => {
    const normalized = relativePath(path);
    return normalized !== null && files.has(normalized);
  });
}

function relativePath(value: unknown): string | null {
  if (typeof value !== "string" || !value || /[\\\0\r\n]/u.test(value) || /^(?:\/|~(?:\/|$)|[A-Za-z]:)/u.test(value)) return null;
  const segments = value.split("/");
  if (segments.includes("..")) return null;
  return segments.filter((segment) => segment && segment !== ".").join("/") || ".";
}

type Command = { cwd: string; argv: string[] };
/** Parse only literal argv plus an optional leading `cd directory &&`.
 * Unsupported shell syntax fails closed rather than matching a substring. */
function parseCommand(command: string, cwd = "."): Command | null {
  const tokens: Array<{ value: string; operator?: boolean }> = [];
  let value = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  const flush = () => { if (started) tokens.push({ value }); value = ""; started = false; };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (/[\0\r\n]/u.test(character)) return null;
    if (quote === "'") {
      if (character === "'") quote = null; else value += character;
    } else if (character === "\\") {
      const next = command[++index];
      if (next === undefined || /[\r\n\0]/u.test(next)) return null;
      value += next; started = true;
    } else if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === "$" || character === "`") return null;
      else value += character;
    } else if (character === "'" || character === '"') {
      quote = character; started = true;
    } else if (/\s/u.test(character)) flush();
    else if (character === "&" && command[index + 1] === "&") {
      flush(); tokens.push({ value: "&&", operator: true }); index += 1;
    } else if (/[;&|<>$`*?(){}]/u.test(character)) return null;
    else { value += character; started = true; }
  }
  if (quote) return null;
  flush();
  if (tokens[0]?.value === "cd" && tokens[2]?.operator) {
    const directory = relativePath(`${cwd}/${tokens[1]?.value ?? ""}`);
    if (directory === null || relativePath(tokens[1]?.value) === null) return null;
    cwd = directory; tokens.splice(0, 3);
  }
  if (!tokens.length || !tokens[0]!.value || tokens.some((token) => token.operator)) return null;
  return { cwd, argv: tokens.map((token) => token.value) };
}
