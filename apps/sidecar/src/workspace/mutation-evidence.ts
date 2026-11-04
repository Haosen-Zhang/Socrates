import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, readSync, writeSync, type Stats } from "node:fs";
import { listPinnedDirectoryEntries, openPinnedWorkspaceEntry, renamePinnedWorkspaceEntryExclusive, unlinkPinnedWorkspaceEntry } from "./native-fs";

export type MutationOptions = { operationId?: string; signal?: AbortSignal };
export type MutationRequest = { operationId: string; kind: "write" | "create" | "delete" | "move"; path: string; destination?: string; expectedNewSha256?: string };
export type EntryIdentity = { dev: number; ino: number; kind: "file" | "directory"; sha256?: string };
export type MutationEvidence = MutationRequest & { version: 1; before: EntryIdentity | null; after: EntryIdentity | null; stage: string; oldSha256?: string | null; newSha256?: string; published?: boolean; journalDev?: number; journalIno?: number };
export type MutationRecovery = {
  disposition: "verify_then_continue" | "requires_user_confirmation" | "recovery_blocked";
  outcome: "applied" | "not_applied" | "unknown";
  evidence?: { kind: MutationRequest["kind"]; path: string; destination?: string; oldSha256?: string | null; newSha256?: string };
  reason?: string;
};

export function sha256(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }
export function mutationNames(operationId: string): { journal: string; stage: string } {
  const key = sha256(operationId);
  return { journal: `.socrates-op-${key}.json`, stage: `.socrates-stage-${key}` };
}
export function sameIdentity(left: EntryIdentity | null, right: EntryIdentity | null): boolean {
  return left === null || right === null ? left === right
    : left.dev === right.dev && left.ino === right.ino && left.kind === right.kind
      && (left.sha256 === undefined || left.sha256 === right.sha256);
}
function unchanged(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && after.nlink === 1;
}
/** Hash the complete descriptor; preview allocation stays bounded independently of file size. */
export function readStableDescriptor(fd: number, maxBytes: number): { bytes: Buffer; byteSize: number; truncated: boolean; sha256: string } {
  const before = fstatSync(fd);
  if (!before.isFile()) throw new Error("workspace_not_file");
  if (before.nlink !== 1) throw new Error("workspace_hardlink_denied");
  const limit = Math.max(1, Math.min(maxBytes, 25 * 1024 * 1024));
  const preview = Buffer.alloc(Math.min(before.size, limit));
  const chunk = Buffer.alloc(64 * 1024);
  const hash = createHash("sha256");
  let offset = 0;
  while (offset < before.size) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, before.size - offset), offset);
    if (!count) throw new Error("WORKSPACE_FILE_CHANGED");
    hash.update(chunk.subarray(0, count));
    if (offset < preview.length) chunk.copy(preview, offset, 0, Math.min(count, preview.length - offset));
    offset += count;
  }
  if (!unchanged(before, fstatSync(fd))) throw new Error("WORKSPACE_FILE_CHANGED");
  return { bytes: preview, byteSize: before.size, truncated: before.size > limit, sha256: hash.digest("hex") };
}
export function inspectEntry(parentFd: number, name: string): EntryIdentity | null {
  let fd: number;
  try { fd = openPinnedWorkspaceEntry(parentFd, name, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)); }
  catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (stat.isSymbolicLink()) throw new Error("workspace_symlink_denied");
    if (stat.isFile()) {
      if (stat.nlink !== 1) throw new Error("workspace_hardlink_denied");
      return { dev: stat.dev, ino: stat.ino, kind: "file", sha256: readStableDescriptor(fd, 1).sha256 };
    }
    if (stat.isDirectory()) return { dev: stat.dev, ino: stat.ino, kind: "directory", sha256: hashDirectory(fd) };
    throw new Error("workspace_tree_kind_unsupported");
  } finally { closeSync(fd); }
}
/** Reject substituted staged entries after a no-replace publication. */
export function assertPublishedEntry(parentFd: number, name: string, stage: string, expected: EntryIdentity | null): void {
  let matches = false;
  try { matches = expected !== null && sameIdentity(expected, inspectEntry(parentFd, name)); }
  catch { /* Move a symlink/hardlink back without following or deleting it. */ }
  if (matches) return;
  try {
    renamePinnedWorkspaceEntryExclusive(parentFd, name, stage);
    fsyncSync(parentFd);
  } catch { /* A concurrent stage is never overwritten. */ }
  throw new Error("WORKSPACE_FILE_CHANGED");
}

function hashDirectory(fd: number, budget = { entries: 0 }): string {
  const before = fstatSync(fd);
  const entries: unknown[] = [];
  for (const name of listPinnedDirectoryEntries(fd, 10_000 - budget.entries)) {
    if (++budget.entries > 10_000) throw new Error("workspace_tree_too_many_entries");
    const child = openPinnedWorkspaceEntry(fd, name, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = fstatSync(child);
      if (stat.isFile()) entries.push([name, "file", readStableDescriptor(child, 1).sha256]);
      else if (stat.isDirectory()) entries.push([name, "directory", hashDirectory(child, budget)]);
      else throw new Error("workspace_tree_kind_unsupported");
    } finally { closeSync(child); }
  }
  const after = fstatSync(fd);
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("WORKSPACE_FILE_CHANGED");
  return sha256(JSON.stringify(entries));
}

export function writeFully(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = writeSync(fd, bytes, offset, bytes.byteLength - offset, offset);
    if (!count) throw new Error("workspace_write_incomplete");
    offset += count;
  }
}
export function persistEvidence(parentFd: number, evidence: MutationEvidence): void {
  const fd = openPinnedWorkspaceEntry(parentFd, mutationNames(evidence.operationId).journal, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    const stat = fstatSync(fd);
    writeFully(fd, Buffer.from(`${JSON.stringify({ ...evidence, journalDev: stat.dev, journalIno: stat.ino })}\n`));
    fsyncSync(fd);
  }
  finally { closeSync(fd); }
  fsyncSync(parentFd);
}
export function updateEvidence(parentFd: number, evidence: MutationEvidence): void {
  const fd = openPinnedWorkspaceEntry(parentFd, mutationNames(evidence.operationId).journal, constants.O_RDWR | constants.O_APPEND);
  try {
    const existing = parseEvidenceDescriptor(fd);
    if (existing.operationId !== evidence.operationId || existing.kind !== evidence.kind || existing.path !== evidence.path) throw new Error("workspace_evidence_invalid");
    const stat = fstatSync(fd);
    const bytes = Buffer.from(`${JSON.stringify({ ...evidence, journalDev: stat.dev, journalIno: stat.ino })}\n`);
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      if (!count) throw new Error("workspace_write_incomplete");
      offset += count;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
function parseEvidenceDescriptor(fd: number): MutationEvidence {
  const result = readStableDescriptor(fd, 64 * 1024);
  if (result.truncated) throw new Error("workspace_evidence_invalid");
  const lines = result.bytes.toString("utf8").split("\n");
  lines.pop(); // A torn trailing append is never authoritative.
  const value = JSON.parse(lines.at(-1) ?? "") as MutationEvidence;
  const stat = fstatSync(fd);
  if (value.journalDev !== stat.dev || value.journalIno !== stat.ino) throw new Error("workspace_evidence_invalid");
  return value;
}
export function readEvidence(parentFd: number, request: MutationRequest): MutationEvidence {
  const fd = openPinnedWorkspaceEntry(parentFd, mutationNames(request.operationId).journal, constants.O_RDONLY);
  try {
    const value = parseEvidenceDescriptor(fd);
    if (value.version !== 1 || value.operationId !== request.operationId || value.kind !== request.kind || value.path !== request.path || value.destination !== request.destination || value.stage !== mutationNames(request.operationId).stage || (request.expectedNewSha256 !== undefined && value.newSha256 !== request.expectedNewSha256)) throw new Error("workspace_evidence_invalid");
    return value;
  } finally { closeSync(fd); }
}
export function removeEvidence(parentFd: number, operationId: string): void {
  const journal = mutationNames(operationId).journal;
  const quarantine = `.socrates-journal-cleanup-${crypto.randomUUID()}`;
  renamePinnedWorkspaceEntryExclusive(parentFd, journal, quarantine);
  try {
    const fd = openPinnedWorkspaceEntry(parentFd, quarantine, constants.O_RDONLY);
    try {
      const value = parseEvidenceDescriptor(fd);
      if (value.operationId !== operationId) throw new Error("workspace_evidence_invalid");
    } finally { closeSync(fd); }
    unlinkPinnedWorkspaceEntry(parentFd, quarantine, false);
    fsyncSync(parentFd);
  } catch (error) {
    try { renamePinnedWorkspaceEntryExclusive(parentFd, quarantine, journal); } catch { /* Preserve a quarantined substitute. */ }
    throw error;
  }
}

/** Remove only a verified retained entry, after the host has committed its result. */
export function removeVerifiedMutationEntry(parentFd: number, name: string, expected: EntryIdentity): void {
  const quarantine = `.socrates-committed-cleanup-${crypto.randomUUID()}`;
  renamePinnedWorkspaceEntryExclusive(parentFd, name, quarantine);
  try {
    if (!sameIdentity(expected, inspectEntry(parentFd, quarantine))) throw new Error("WORKSPACE_FILE_CHANGED");
    // Retained stages are single files or already verified empty directories.
    // Never recursively delete data as part of result cleanup.
    unlinkPinnedWorkspaceEntry(parentFd, quarantine, expected.kind === "directory");
    fsyncSync(parentFd);
  } catch (error) {
    try { renamePinnedWorkspaceEntryExclusive(parentFd, quarantine, name); } catch { /* Preserve an ambiguous quarantine. */ }
    throw error;
  }
}

/** A bounded, real replacement hunk; unchanged prefix/suffix lines are omitted. */
export function boundedDiff(path: string, before: string | null, after: string, basisTruncated: boolean): { diff: string; diffTruncated: boolean } {
  const limit = 16 * 1024;
  if (basisTruncated) return { diff: "", diffTruncated: true };
  if (before === after) return { diff: "", diffTruncated: false };
  const oldLines = (before ?? "").match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const newLines = after.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let start = 0; let end = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  while (end < oldLines.length - start && end < newLines.length - start && oldLines[oldLines.length - 1 - end] === newLines[newLines.length - 1 - end]) end++;
  const oldChanged = oldLines.slice(start, oldLines.length - end); const newChanged = newLines.slice(start, newLines.length - end);
  const chunks = [`--- a/${path}\n+++ b/${path}\n@@ -${oldChanged.length ? start + 1 : start},${oldChanged.length} +${newChanged.length ? start + 1 : start},${newChanged.length} @@\n`];
  let bytes = Buffer.byteLength(chunks[0]!); let truncated: boolean = false;
  for (const [prefix, lines] of [["-", oldChanged], ["+", newChanged]] as const) {
    for (const line of lines) {
      const next = `${prefix}${line}${line.endsWith("\n") ? "" : "\n\\ No newline at end of file\n"}`;
      if (bytes + Buffer.byteLength(next) > limit) { truncated = true; break; }
      chunks.push(next); bytes += Buffer.byteLength(next);
    }
  }
  return { diff: chunks.join(""), diffTruncated: truncated };
}
