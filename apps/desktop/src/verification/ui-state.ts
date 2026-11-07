import type { VerificationCheck, VerificationView } from "@socrates/core";

export function verificationSummary(view: VerificationView): { passed: number; total: number; verified: boolean } {
  const required = view.plan?.checks.filter(check => check.required) ?? [];
  const run = view.run;
  const current = run?.mode === "final" && run.planId === view.plan?.id && run.planHash === view.plan?.hash && view.verificationStatus !== "invalidated";
  const passed = current ? required.filter(check => run.evidence.some(evidence => evidence.checkId === check.id && evidence.status === "passed" && evidence.planHash === run.planHash && evidence.artifactSnapshotHash === run.snapshot.hash && (check.kind !== "command" || check.category !== "test" || Boolean(evidence.counts && evidence.counts.passed >= (check.minTests ?? 1) && evidence.counts.failed === 0)))).length : 0;
  return { passed, total: required.length, verified: Boolean(current && view.verificationStatus === "passed" && view.outcome === "verified_success" && required.length > 0 && passed === required.length && !view.plan?.manualJudgment.length) };
}

export interface CheckDraft {
  kind: VerificationCheck["kind"];
  label: string;
  path: string;
  contains: string;
  schema: string;
  executable: string;
  argv: string;
  cwd: string;
  category: "test" | "typecheck" | "build" | "lint";
  parser: "exit_code" | "bun_test" | "tap" | "junit" | "unsupported";
  reportPath: string;
  timeoutSeconds: string;
  definitionPaths: string;
  required: boolean;
}

export function emptyCheckDraft(): CheckDraft {
  return { kind: "file", label: "", path: "", contains: "", schema: '{"type":"object"}', executable: "bun", argv: '["test"]', cwd: ".", category: "test", parser: "bun_test", reportPath: "", timeoutSeconds: "120", definitionPaths: "", required: true };
}

export function parsePaths(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map(path => path.trim()).filter(Boolean))];
}

export function buildCheck(draft: CheckDraft, id: string): VerificationCheck {
  if (!draft.label.trim()) throw new Error("verification_check_label_required");
  const base = { id, label: draft.label.trim(), required: draft.required, origin: "user" as const, definitionPaths: parsePaths(draft.definitionPaths) };
  if (draft.kind === "command") {
    let argv: unknown;
    try { argv = JSON.parse(draft.argv); } catch { throw new Error("verification_invalid_argv"); }
    if (!Array.isArray(argv) || !argv.every(value => typeof value === "string")) throw new Error("verification_invalid_argv");
    const timeout = Number(draft.timeoutSeconds);
    if (!draft.executable.trim() || !Number.isInteger(timeout) || timeout < 1 || timeout > 120) throw new Error("verification_invalid_command");
    return { ...base, kind: "command", category: draft.category, command: { executable: draft.executable.trim(), argv, cwd: draft.cwd.trim() || ".", timeoutMs: timeout * 1000 },
      parser: draft.category === "test" ? draft.parser : "exit_code", ...(draft.reportPath.trim() ? { reportPath: draft.reportPath.trim() } : {}), ...(draft.category === "test" ? { minTests: 1 } : {}) };
  }
  if (!draft.path.trim()) throw new Error("verification_path_required");
  if (draft.kind === "json_schema") {
    let schema: unknown;
    try { schema = JSON.parse(draft.schema); } catch { throw new Error("verification_invalid_schema"); }
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("verification_invalid_schema");
    return { ...base, kind: "json_schema", path: draft.path.trim(), schema };
  }
  return { ...base, kind: "file", path: draft.path.trim(), minBytes: 1, ...(draft.contains ? { contains: draft.contains } : {}) };
}

/** A mutation invalidates earlier polls before they can overwrite its result. */
export class VerificationReadGuard {
  private epoch = 0;
  begin(): number { return ++this.epoch; }
  invalidate(): void { this.epoch++; }
  accepts(ticket: number): boolean { return this.epoch === ticket; }
}

/** Cancellation must remain available while an approved command's HTTP request
 * is waiting for the process. Other changes still serialize to avoid duplicates. */
export class VerificationMutationGate {
  private pending = false;
  private cancelling = false;
  begin(path: string): boolean {
    if (path === "/cancel") {
      if (this.cancelling) return false;
      this.cancelling = true;
    } else {
      if (this.pending || this.cancelling) return false;
      this.pending = true;
    }
    return true;
  }
  finish(path: string): void {
    if (path === "/cancel") this.cancelling = false;
    else this.pending = false;
  }
}
