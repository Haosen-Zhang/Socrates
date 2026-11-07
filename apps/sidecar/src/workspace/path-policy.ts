import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { normalizeWorkspaceRelativePath, StructuredExecutionError } from "@socrates/core";
import {
  listPinnedDirectoryEntries,
  mkdirPinnedWorkspaceEntry,
  openPinnedWorkspaceEntry,
  removePinnedWorkspaceTree,
  renamePinnedWorkspaceEntryExclusive,
  renamePinnedWorkspaceEntryExclusiveBetween,
  unlinkPinnedWorkspaceEntry,
  swapPinnedWorkspaceEntries,
  withCreatedPinnedWorkspaceParent,
  withCreatedPinnedDirectoryParent,
  withPinnedWorkspaceParent,
} from "./native-fs";

import { assertPublishedEntry, boundedDiff, inspectEntry, mutationNames, persistEvidence, updateEvidence, readEvidence, readStableDescriptor, removeEvidence, removeVerifiedMutationEntry, sameIdentity, sha256, writeFully, type MutationOptions, type MutationRequest, type MutationRecovery } from "./mutation-evidence";

const SECRET_SEGMENTS = new Set([".env", ".ssh", ".gnupg", ".aws", ".npmrc", ".pypirc"]);
const SECRET_SUFFIXES = [".pem", ".key", ".p12", ".pfx"];

export function isSecretWorkspacePath(relativePath: string): boolean {
  const normalized = relativePath.toLowerCase().replaceAll("\\", "/");
  const segments = normalized.split("/");
  return segments.some((segment) => SECRET_SEGMENTS.has(segment))
    || SECRET_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
    || segments.includes(".git")
    || segments.some((segment) => segment.startsWith(".socrates-"));
}

export interface ResolvedWorkspacePath {
  absolutePath: string;
  relativePath: string;
}

export type WorkspaceDirectoryEntry = { name: string; kind: "file" | "directory" };

export type DeletionTarget = ResolvedWorkspacePath & {
  kind: "file" | "directory";
  dev: number;
  ino: number;
};

export type WorkspaceTreeEntry =
  | { kind: "directory"; path: string }
  | { kind: "file"; path: string; bytes: Buffer };

export type WorkspaceTreeSnapshot = {
  kind: "file" | "directory";
  entries: WorkspaceTreeEntry[];
  totalBytes: number;
};

export class WorkspacePathPolicy {
  readonly canonicalRoot: string;

  constructor(root: string) {
    this.canonicalRoot = realpathSync(root).normalize("NFC");
  }

  resolveExisting(input: string): ResolvedWorkspacePath {
    const relativePath = normalizeWorkspaceRelativePath(input);
    const lexical = join(this.canonicalRoot, relativePath);
    this.assertContained(lexical);
    this.assertNoSymlink(relativePath);
    const canonical = realpathSync(lexical).normalize("NFC");
    this.assertContained(canonical);
    return { absolutePath: canonical, relativePath };
  }

  resolveMutationTarget(input: string): ResolvedWorkspacePath {
    const relativePath = normalizeWorkspaceRelativePath(input);
    if (!relativePath) throw new Error("workspace_root_mutation_denied");
    this.assertNotSecret(relativePath);
    const lexical = join(this.canonicalRoot, relativePath);
    this.assertContained(lexical);

    let cursor = this.canonicalRoot;
    for (const segment of relativePath.split("/")) {
      cursor = join(cursor, segment);
      if (!existsSync(cursor)) break;
      if (lstatSync(cursor).isSymbolicLink()) throw new Error("workspace_symlink_denied");
      const canonical = realpathSync(cursor).normalize("NFC");
      this.assertContained(canonical);
    }
    return { absolutePath: lexical.normalize("NFC"), relativePath };
  }

  readText(input: string, maxBytes: number): { path: string; relativePath: string; text: string; byteSize: number; truncated: boolean; sha256: string } {
    const result = this.readBytes(input, maxBytes);
    if (result.bytes.includes(0)) throw new Error("workspace_binary_file");
    let text: string;
    try {
      // A byte limit may split the final code point. Streaming decoding omits
      // only that incomplete preview suffix without accepting invalid UTF-8.
      text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes, { stream: result.truncated });
    } catch { throw new Error("workspace_non_utf8_file"); }
    return { path: result.path, relativePath: result.path, text, byteSize: result.byteSize, truncated: result.truncated, sha256: result.sha256 };
  }

  readBytes(input: string, maxBytes: number): { path: string; bytes: Buffer; byteSize: number; truncated: boolean; sha256: string } {
    const resolved = this.resolveExisting(input);
    this.assertNotSecret(resolved.relativePath);
    const before = lstatSync(resolved.absolutePath);
    if (!before.isFile()) throw new Error("workspace_not_file");
    if (before.nlink > 1) throw new Error("workspace_hardlink_denied");
    return withPinnedWorkspaceParent(this.canonicalRoot, resolved.relativePath, (parentFd, basename) => {
      const fd = openPinnedWorkspaceEntry(parentFd, basename, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
      try {
        const opened = fstatSync(fd);
        if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("workspace_file_changed");
        const result = readStableDescriptor(fd, maxBytes);
        if (!sameIdentity({ dev: opened.dev, ino: opened.ino, kind: "file", sha256: result.sha256 }, inspectEntry(parentFd, basename))) throw new Error("WORKSPACE_FILE_CHANGED");
        return { path: resolved.relativePath, ...result };
      } finally { closeSync(fd); }
    });
  }

  listDirectory(input: string, maxEntries: number): { entries: WorkspaceDirectoryEntry[]; truncated: boolean } {
    const resolved = this.resolveExisting(input || ".");
    this.assertNotSecret(resolved.relativePath);
    const before = lstatSync(resolved.absolutePath);
    if (!before.isDirectory()) throw new Error("workspace_not_directory");
    const fd = openSync(
      resolved.absolutePath,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("workspace_path_changed");
      const limit = Math.max(1, Math.min(maxEntries, 500));
      const names = listPinnedDirectoryEntries(fd, limit, true);
      const truncated = names.length > limit;
      const entries: WorkspaceDirectoryEntry[] = [];
      for (const name of names.slice(0, limit)) {
        const relativePath = [resolved.relativePath, name].filter(Boolean).join("/");
        if (isSecretWorkspacePath(relativePath)) continue;
        let childFd: number | null = null;
        try {
          childFd = openPinnedWorkspaceEntry(fd, name, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
          const stat = fstatSync(childFd);
          if (stat.isDirectory()) entries.push({ name, kind: "directory" });
          else if (stat.isFile() && stat.nlink <= 1) entries.push({ name, kind: "file" });
        } catch {
          // The entry changed after enumeration; omit it rather than following a new target.
        } finally {
          if (childFd !== null) closeSync(childFd);
        }
      }
      return { entries, truncated };
    } finally {
      closeSync(fd);
    }
  }

  writeText(input: string, content: string, options: MutationOptions & { expectedSha256?: string | null } = {}): {
    relativePath: string; existed: boolean; oldSha256: string | null; newSha256: string; diff: string; diffTruncated: boolean;
  } {
    options.signal?.throwIfAborted();
    const resolved = this.resolveMutationTarget(input);
    const before = existsSync(resolved.absolutePath) ? lstatSync(resolved.absolutePath) : null;
    if (before && !before.isFile()) throw new Error("workspace_not_file");
    if (before && before.nlink > 1) throw new Error("workspace_hardlink_denied");
    const bytes = Buffer.from(content, "utf8");
    return withCreatedPinnedWorkspaceParent(this.canonicalRoot, resolved.relativePath, (parentFd, basename) => {
      const existing = inspectEntry(parentFd, basename);
      if (before && (!existing || existing.dev !== before.dev || existing.ino !== before.ino)) throw new Error("WORKSPACE_FILE_CHANGED");
      if (!before && existing) throw new Error("WORKSPACE_FILE_CHANGED");
      if (options.expectedSha256 !== undefined && (existing?.sha256 ?? null) !== options.expectedSha256) {
        throw new StructuredExecutionError({ code: "WORKSPACE_FILE_CHANGED", category: "filesystem", phase: "tool_execution", retryable: false,
          message: existing
            ? "WORKSPACE_FILE_CHANGED: The target exists or changed. Read it with read_file and copy its current sha256 before updating; do not guess hashes or repeat the stale input."
            : "WORKSPACE_FILE_CHANGED: The target does not exist. To create it, use expectedSha256: null; do not invent a hash or use the hash of an empty file." });
      }
      let oldText: string | null = null; let basisTruncated = false;
      if (existing) {
        const fd = openPinnedWorkspaceEntry(parentFd, basename, constants.O_RDONLY);
        try {
          const basis = readStableDescriptor(fd, 64 * 1024);
          if (basis.sha256 !== existing.sha256) throw new Error("WORKSPACE_FILE_CHANGED");
          basisTruncated = basis.truncated;
          if (!basis.truncated) oldText = basis.bytes.toString("utf8");
        } finally { closeSync(fd); }
      }
      const operationId = options.operationId ?? crypto.randomUUID();
      const names = mutationNames(operationId);
      // Adapted from DeepSeek Harness fs-local/fsio.ts writeFileAtomic at
      // 8bd073392eef6f54e921a093b95076248eb08cbb: exclusive sibling staging,
      // complete write + fsync + preserved mode, abort before publication.
      // Publication uses Socrates' pinned native primitives instead of rename.
      const fd = openPinnedWorkspaceEntry(parentFd, names.stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      let published = false; let evidenceWritten = false;
      const newSha256 = sha256(bytes);
      try {
        const staged = fstatSync(fd);
        const after = { dev: staged.dev, ino: staged.ino, kind: "file" as const, sha256: newSha256 };
        persistEvidence(parentFd, { version: 1, operationId, kind: "write", path: resolved.relativePath, before: existing, after, stage: names.stage, oldSha256: existing?.sha256 ?? null, newSha256 });
        evidenceWritten = true;
        writeFully(fd, bytes);
        if (before) fchmodSync(fd, before.mode & 0o777);
        fsyncSync(fd);
        options.signal?.throwIfAborted();
        if (!sameIdentity(existing, inspectEntry(parentFd, basename))) throw new Error("WORKSPACE_FILE_CHANGED");
        if (!sameIdentity(after, inspectEntry(parentFd, names.stage))) throw new Error("WORKSPACE_FILE_CHANGED");
        if (existing) {
          swapPinnedWorkspaceEntries(parentFd, names.stage, basename);
          published = true;
          // The displaced entry proves the exchange actually replaced the
          // observed inode, including a substitution at the syscall boundary.
          let displacedMatches = false;
          try { displacedMatches = sameIdentity(existing, inspectEntry(parentFd, names.stage)); }
          catch { /* A symlink/hardlink substitution must also be restored. */ }
          if (!displacedMatches) {
            if (sameIdentity(after, inspectEntry(parentFd, basename))) {
              swapPinnedWorkspaceEntries(parentFd, names.stage, basename);
              published = false;
              fsyncSync(parentFd);
            }
            throw new Error("WORKSPACE_FILE_CHANGED");
          }
          unlinkPinnedWorkspaceEntry(parentFd, names.stage, false);
        } else {
          renamePinnedWorkspaceEntryExclusive(parentFd, names.stage, basename);
          published = true;
          assertPublishedEntry(parentFd, basename, names.stage, after);
        }
        fsyncSync(parentFd);
        if (!options.operationId) removeEvidence(parentFd, operationId);
        return { relativePath: resolved.relativePath, existed: existing !== null, oldSha256: existing?.sha256 ?? null, newSha256, ...boundedDiff(resolved.relativePath, oldText, content.slice(0, 64 * 1024), basisTruncated || bytes.byteLength > 64 * 1024) };
      } catch (error) {
        if (!published) {
          // Never remove a substituted staging name or the displaced original.
          try {
            const stage = inspectEntry(parentFd, names.stage);
            const opened = fstatSync(fd);
            if (stage?.dev === opened.dev && stage.ino === opened.ino) unlinkPinnedWorkspaceEntry(parentFd, names.stage, false);
            if (evidenceWritten && !options.operationId) removeEvidence(parentFd, operationId);
          } catch { /* Preserve ambiguous evidence for inspection. */ }
        }
        throw error;
      } finally { closeSync(fd); }
    });
  }

  recoverMutation(request: MutationRequest): MutationRecovery {
    try {
      const resolved = this.resolveMutationTarget(request.path);
      if (resolved.relativePath !== request.path) throw new Error("workspace_evidence_path_mismatch");
      if (request.destination) this.resolveMutationTarget(request.destination);
      return withPinnedWorkspaceParent(this.canonicalRoot, request.path, (parentFd, basename) => {
        const evidence = readEvidence(parentFd, request);
        const current = inspectEntry(parentFd, basename);
        const projected = { kind: evidence.kind, path: evidence.path, destination: evidence.destination, oldSha256: evidence.oldSha256, newSha256: evidence.newSha256 };
        if (request.kind === "write" || request.kind === "create") {
          if (evidence.after && sameIdentity(evidence.after, current)) {
            const displaced = inspectEntry(parentFd, evidence.stage);
            if (!displaced || (evidence.before && sameIdentity(evidence.before, displaced))) return { disposition: "verify_then_continue", outcome: "applied", evidence: projected };
            return { disposition: "requires_user_confirmation", outcome: "unknown", evidence: projected, reason: "workspace_displaced_entry_changed" };
          }
          if (sameIdentity(evidence.before, current)) return { disposition: "verify_then_continue", outcome: "not_applied", evidence: projected };
        } else if (request.kind === "move" && request.destination) {
          const target = withPinnedWorkspaceParent(this.canonicalRoot, request.destination, (fd, name) => inspectEntry(fd, name));
          if (!current && evidence.before && sameIdentity(evidence.before, target)) return { disposition: "verify_then_continue", outcome: "applied", evidence: projected };
          if (sameIdentity(evidence.before, current) && !target) return { disposition: "verify_then_continue", outcome: "not_applied", evidence: projected };
        } else if (request.kind === "delete") {
          const quarantined = inspectEntry(parentFd, evidence.stage);
          if (!current && ((quarantined && sameIdentity(evidence.before, quarantined)) || (evidence.published === true && !quarantined))) return { disposition: "verify_then_continue", outcome: "applied", evidence: projected };
          if (sameIdentity(evidence.before, current) && !quarantined) return { disposition: "verify_then_continue", outcome: "not_applied", evidence: projected };
        }
        return { disposition: "requires_user_confirmation", outcome: "unknown", evidence: projected, reason: "workspace_mutation_evidence_diverged" };
      });
    } catch (error) { return { disposition: "recovery_blocked", outcome: "unknown", reason: error instanceof Error ? error.message : String(error) }; }
  }

  /** Host-only postcommit cleanup. Failure preserves proof and never reverses success. */
  finalizeCommittedMutation(request: MutationRequest): boolean {
    try {
      const path = normalizeWorkspaceRelativePath(request.path);
      if (!path || path !== request.path) return false;
      this.assertNotSecret(path);
      if (request.destination) this.assertNotSecret(normalizeWorkspaceRelativePath(request.destination));
      // Durable SQL success, checked by the host, is authoritative even when
      // later user edits changed the destination. Verify only our exact journal
      // and retained staging identities; never touch the current destination.
      return withPinnedWorkspaceParent(this.canonicalRoot, request.path, (parentFd) => {
        const evidence = readEvidence(parentFd, request);
        const retained = inspectEntry(parentFd, evidence.stage);
        if (retained) {
          if ((request.kind !== "write" && request.kind !== "delete") || !evidence.before || !sameIdentity(evidence.before, retained)) return false;
          removeVerifiedMutationEntry(parentFd, evidence.stage, evidence.before);
        }
        removeEvidence(parentFd, request.operationId);
        return true;
      });
    } catch { return false; }
  }

  createDirectory(input: string, options: MutationOptions = {}): { path: string } {
    options.signal?.throwIfAborted();
    const resolved = this.resolveMutationTarget(input);
    withCreatedPinnedWorkspaceParent(this.canonicalRoot, resolved.relativePath, (parentFd, basename) => {
      const operationId = options.operationId ?? crypto.randomUUID();
      const { stage } = mutationNames(operationId);
      mkdirPinnedWorkspaceEntry(parentFd, stage);
      const after = inspectEntry(parentFd, stage);
      let published = false;
      try {
        persistEvidence(parentFd, { version: 1, operationId, kind: "create", path: resolved.relativePath, before: null, after, stage, newSha256: after?.sha256 });
        options.signal?.throwIfAborted();
        renamePinnedWorkspaceEntryExclusive(parentFd, stage, basename);
        published = true;
        assertPublishedEntry(parentFd, basename, stage, after);
        fsyncSync(parentFd);
        if (!options.operationId) removeEvidence(parentFd, operationId);
      } catch (error) {
        if (!published) {
          try {
            if (sameIdentity(after, inspectEntry(parentFd, stage))) unlinkPinnedWorkspaceEntry(parentFd, stage, true);
            if (!options.operationId) removeEvidence(parentFd, operationId);
          } catch { /* Preserve ambiguous stage. */ }
        }
        throw error;
      }
    });
    return { path: resolved.relativePath };
  }

  createFile(input: string, bytes: Uint8Array, options: MutationOptions = {}): { path: string; byteSize: number } {
    options.signal?.throwIfAborted();
    const resolved = this.resolveMutationTarget(input);
    withCreatedPinnedWorkspaceParent(this.canonicalRoot, resolved.relativePath, (parentFd, basename) => {
      const operationId = options.operationId ?? crypto.randomUUID();
      const { stage } = mutationNames(operationId);
      const fd = openPinnedWorkspaceEntry(parentFd, stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      let published = false;
      try {
        const stat = fstatSync(fd);
        const after = { dev: stat.dev, ino: stat.ino, kind: "file" as const, sha256: sha256(bytes) };
        persistEvidence(parentFd, { version: 1, operationId, kind: "create", path: resolved.relativePath, before: null, after, stage, newSha256: after.sha256 });
        writeFully(fd, bytes); fsyncSync(fd);
        options.signal?.throwIfAborted();
        if (!sameIdentity(after, inspectEntry(parentFd, stage))) throw new Error("WORKSPACE_FILE_CHANGED");
        renamePinnedWorkspaceEntryExclusive(parentFd, stage, basename);
        published = true;
        assertPublishedEntry(parentFd, basename, stage, after);
        fsyncSync(parentFd);
        if (!options.operationId) removeEvidence(parentFd, operationId);
      } catch (error) {
        if (!published) {
          try {
            const staged = inspectEntry(parentFd, stage); const opened = fstatSync(fd);
            if (staged?.dev === opened.dev && staged.ino === opened.ino) unlinkPinnedWorkspaceEntry(parentFd, stage, false);
            if (!options.operationId) removeEvidence(parentFd, operationId);
          } catch { /* Never remove a substituted entry. */ }
        }
        throw error;
      } finally { closeSync(fd); }
    });
    return { path: resolved.relativePath, byteSize: bytes.byteLength };
  }

  createTree(input: string, snapshot: WorkspaceTreeSnapshot, options: MutationOptions = {}): {
    path: string;
    entries: number;
    byteSize: number;
  } {
    options.signal?.throwIfAborted();
    if (snapshot.kind !== "directory") throw new Error("workspace_tree_not_directory");
    const resolved = this.resolveMutationTarget(input);
    withCreatedPinnedWorkspaceParent(this.canonicalRoot, resolved.relativePath, (parentFd, basename) => {
      const operationId = options.operationId ?? crypto.randomUUID();
      const stagingName = mutationNames(operationId).stage;
      let staged = false;
      let stageFd: number | null = null;
      let stageIdentity: { dev: number; ino: number; kind: "directory" } | null = null;
      try {
        mkdirPinnedWorkspaceEntry(parentFd, stagingName);
        staged = true;
        stageFd = openPinnedWorkspaceEntry(parentFd, stagingName, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
        const stageStat = fstatSync(stageFd);
        stageIdentity = { dev: stageStat.dev, ino: stageStat.ino, kind: "directory" };
        const initial = { version: 1 as const, operationId, kind: "create" as const, path: resolved.relativePath, before: null, after: null, stage: stagingName };
        persistEvidence(parentFd, initial);
        for (const entry of snapshot.entries) {
          options.signal?.throwIfAborted();
          const childPath = normalizeWorkspaceRelativePath(entry.path);
          if (!childPath) throw new Error("workspace_tree_entry_invalid");
          this.createStagedTreeEntry(stageFd, childPath, entry);
        }
        fsyncSync(stageFd);
        const after = inspectEntry(parentFd, stagingName);
        if (!sameIdentity(stageIdentity, after)) throw new Error("WORKSPACE_FILE_CHANGED");
        updateEvidence(parentFd, { ...initial, after, newSha256: after?.sha256 });
        options.signal?.throwIfAborted();
        renamePinnedWorkspaceEntryExclusive(parentFd, stagingName, basename);
        staged = false;
        assertPublishedEntry(parentFd, basename, stagingName, after);
        fsyncSync(parentFd);
        if (!options.operationId) removeEvidence(parentFd, operationId);
      } catch (error) {
        if (staged) {
          try {
            if (sameIdentity(stageIdentity, inspectEntry(parentFd, stagingName))) removePinnedWorkspaceTree(parentFd, stagingName);
            if (!options.operationId) removeEvidence(parentFd, operationId);
          } catch {
            // Preserve a quarantined staging tree if its identity cannot be
            // verified safely; never touch the requested destination.
          }
        }
        throw error;
      } finally { if (stageFd !== null) closeSync(stageFd); }
    });
    return {
      path: resolved.relativePath,
      entries: snapshot.entries.length,
      byteSize: snapshot.totalBytes,
    };
  }

  private createStagedTreeEntry(stageFd: number, relativePath: string, entry: WorkspaceTreeEntry): void {
    // A tree payload must never smuggle credentials into a staging directory.
    this.assertNotSecret(entry.path);
    withCreatedPinnedDirectoryParent(stageFd, relativePath, (fd, name) => {
      if (entry.kind === "directory") mkdirPinnedWorkspaceEntry(fd, name);
      else {
        const child = openPinnedWorkspaceEntry(fd, name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try { writeFully(child, entry.bytes); fsyncSync(child); } finally { closeSync(child); }
      }
      fsyncSync(fd);
    });
  }

  snapshotTree(
    input: string,
    limits: { maxEntries: number; maxBytes: number },
  ): WorkspaceTreeSnapshot {
    const resolved = this.resolveExisting(input);
    this.assertNotSecret(resolved.relativePath);
    const entries: WorkspaceTreeEntry[] = [];
    let totalBytes = 0;
    let seenEntries = 0;

    const readFileDescriptor = (fd: number): Buffer => {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error("workspace_not_file");
      if (stat.nlink > 1) throw new Error("workspace_hardlink_denied");
      if (stat.size > limits.maxBytes - totalBytes) throw new Error("workspace_tree_too_large");
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < stat.size) {
        const count = readSync(fd, bytes, offset, stat.size - offset, offset);
        if (count === 0) throw new Error("workspace_file_changed");
        offset += count;
      }
      totalBytes += stat.size;
      return bytes;
    };

    const walkDirectory = (directoryFd: number, prefix: string): void => {
      const remaining = Math.max(0, limits.maxEntries - seenEntries);
      for (const name of listPinnedDirectoryEntries(directoryFd, remaining)) {
        const childPath = prefix ? `${prefix}/${name}` : name;
        this.assertNotSecret(`${resolved.relativePath}/${childPath}`);
        seenEntries += 1;
        if (seenEntries > limits.maxEntries) throw new Error("workspace_tree_too_many_entries");
        const childFd = openPinnedWorkspaceEntry(
          directoryFd,
          name,
          constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
        );
        try {
          const stat = fstatSync(childFd);
          if (stat.isDirectory()) {
            entries.push({ kind: "directory", path: childPath });
            walkDirectory(childFd, childPath);
          } else if (stat.isFile()) {
            entries.push({ kind: "file", path: childPath, bytes: readFileDescriptor(childFd) });
          } else {
            throw new Error("workspace_tree_kind_unsupported");
          }
        } finally {
          closeSync(childFd);
        }
      }
    };

    withPinnedWorkspaceParent(this.canonicalRoot, resolved.relativePath, (parentFd, basename) => {
      const fd = openPinnedWorkspaceEntry(
        parentFd,
        basename,
        constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
      );
      try {
        const stat = fstatSync(fd);
        if (stat.isFile()) {
          seenEntries += 1;
          if (seenEntries > limits.maxEntries) throw new Error("workspace_tree_too_many_entries");
          entries.push({ kind: "file", path: "", bytes: readFileDescriptor(fd) });
        } else if (stat.isDirectory()) {
          walkDirectory(fd, "");
        } else {
          throw new Error("workspace_tree_kind_unsupported");
        }
      } finally {
        closeSync(fd);
      }
    });
    return {
      kind: entries.length === 1 && entries[0]?.kind === "file" && entries[0].path === ""
        ? "file"
        : "directory",
      entries,
      totalBytes,
    };
  }

  movePath(input: string, destination: string, options: MutationOptions = {}): { from: string; to: string; kind: "file" | "directory" } {
    options.signal?.throwIfAborted();
    const source = this.resolveExisting(input);
    this.assertNotSecret(source.relativePath);
    const target = this.resolveMutationTarget(destination);
    const sourcePrefix = `${source.relativePath}/`;
    if (target.relativePath.startsWith(sourcePrefix)) throw new Error("workspace_move_into_self");
    const before = lstatSync(source.absolutePath);
    if (before.isSymbolicLink()) throw new Error("workspace_symlink_denied");
    const kind = before.isDirectory() ? "directory" : before.isFile() ? "file" : null;
    if (!kind) throw new Error("workspace_move_kind_unsupported");
    if (kind === "file" && before.nlink > 1) throw new Error("workspace_hardlink_denied");

    withPinnedWorkspaceParent(this.canonicalRoot, source.relativePath, (sourceParentFd, sourceName) => {
      withCreatedPinnedWorkspaceParent(this.canonicalRoot, target.relativePath, (targetParentFd, targetName) => {
        const fd = openPinnedWorkspaceEntry(
          sourceParentFd,
          sourceName,
          constants.O_RDONLY | (kind === "directory" ? (constants.O_DIRECTORY ?? 0) : 0),
        );
        try {
          const opened = fstatSync(fd);
          if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("workspace_file_changed");
          if (kind === "file" && opened.nlink > 1) throw new Error("workspace_hardlink_denied");
        } finally {
          closeSync(fd);
        }
        const operationId = options.operationId ?? crypto.randomUUID();
        const identity = inspectEntry(sourceParentFd, sourceName);
        if (!identity || identity.dev !== before.dev || identity.ino !== before.ino) throw new Error("WORKSPACE_FILE_CHANGED");
        persistEvidence(sourceParentFd, { version: 1, operationId, kind: "move", path: source.relativePath, destination: target.relativePath, before: identity, after: identity, stage: mutationNames(operationId).stage, oldSha256: identity.sha256, newSha256: identity.sha256 });
        options.signal?.throwIfAborted();
        renamePinnedWorkspaceEntryExclusiveBetween(sourceParentFd, sourceName, targetParentFd, targetName);
        let movedMatches = false;
        try { movedMatches = sameIdentity(identity, inspectEntry(targetParentFd, targetName)); } catch { /* Restore a substituted entry without following it. */ }
        if (!movedMatches) {
          try {
            renamePinnedWorkspaceEntryExclusiveBetween(targetParentFd, targetName, sourceParentFd, sourceName);
            fsyncSync(sourceParentFd); fsyncSync(targetParentFd);
          } catch { /* Never overwrite a concurrent source; retain recovery evidence. */ }
          throw new Error("WORKSPACE_FILE_CHANGED");
        }
        fsyncSync(targetParentFd); fsyncSync(sourceParentFd);
        if (!options.operationId) removeEvidence(sourceParentFd, operationId);
      });
    });
    return { from: source.relativePath, to: target.relativePath, kind };
  }

  inspectDeletionTarget(input: string): DeletionTarget {
    const resolved = this.resolveMutationTarget(input);
    let stat;
    try {
      stat = lstatSync(resolved.absolutePath);
    } catch {
      throw new Error("workspace_path_not_found");
    }
    if (stat.isSymbolicLink()) throw new Error("workspace_symlink_denied");
    if (stat.isFile()) {
      if (stat.nlink > 1) throw new Error("workspace_hardlink_denied");
      return { ...resolved, kind: "file", dev: stat.dev, ino: stat.ino };
    }
    if (stat.isDirectory()) {
      if (readdirSync(resolved.absolutePath).length > 0) throw new Error("workspace_directory_not_empty");
      return { ...resolved, kind: "directory", dev: stat.dev, ino: stat.ino };
    }
    throw new Error("workspace_delete_kind_unsupported");
  }

  deletePath(input: string, options: MutationOptions = {}): { path: string; kind: "file" | "directory" } {
    options.signal?.throwIfAborted();
    const target = this.inspectDeletionTarget(input);
    withPinnedWorkspaceParent(this.canonicalRoot, target.relativePath, (parentFd, basename) => {
      const operationId = options.operationId ?? crypto.randomUUID();
      const quarantineName = mutationNames(operationId).stage;
      const identity = inspectEntry(parentFd, basename);
      if (!identity || identity.dev !== target.dev || identity.ino !== target.ino) throw new Error("WORKSPACE_FILE_CHANGED");
      const evidence = { version: 1 as const, operationId, kind: "delete" as const, path: target.relativePath, before: identity, after: null, stage: quarantineName, oldSha256: identity.sha256 };
      persistEvidence(parentFd, evidence);
      options.signal?.throwIfAborted();
      renamePinnedWorkspaceEntryExclusive(parentFd, basename, quarantineName);
      fsyncSync(parentFd);
      try {
        const fd = openPinnedWorkspaceEntry(
          parentFd,
          quarantineName,
          constants.O_RDONLY | (target.kind === "directory" ? (constants.O_DIRECTORY ?? 0) : 0),
        );
        try {
          const opened = fstatSync(fd);
          if (opened.dev !== target.dev || opened.ino !== target.ino) throw new Error("workspace_file_changed");
          if (target.kind === "file" && opened.nlink > 1) throw new Error("workspace_hardlink_denied");
        } finally {
          closeSync(fd);
        }
        if (!sameIdentity(identity, inspectEntry(parentFd, quarantineName))) throw new Error("WORKSPACE_FILE_CHANGED");
        updateEvidence(parentFd, { ...evidence, published: true });
        unlinkPinnedWorkspaceEntry(parentFd, quarantineName, target.kind === "directory");
        fsyncSync(parentFd);
        if (!options.operationId) removeEvidence(parentFd, operationId);
      } catch (error) {
        try {
          renamePinnedWorkspaceEntryExclusive(parentFd, quarantineName, basename);
        } catch {
          // Preserve the quarantined entry rather than deleting an identity
          // that could not be verified or overwriting a concurrent target.
        }
        throw error;
      }
    });
    return { path: target.relativePath, kind: target.kind };
  }

  private assertContained(path: string): void {
    const rel = relative(this.canonicalRoot, path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("workspace_path_outside");
  }

  private assertNoSymlink(relativePath: string): void {
    let cursor = this.canonicalRoot;
    for (const segment of relativePath.split("/").filter(Boolean)) {
      cursor = join(cursor, segment);
      if (lstatSync(cursor).isSymbolicLink()) throw new Error("workspace_symlink_denied");
    }
  }

  private assertNotSecret(relativePath: string): void {
    if (isSecretWorkspacePath(relativePath)) throw new Error("workspace_secret_path_denied");
  }
}
