import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { normalizeWorkspaceRelativePath } from "@socrates/core";
import {
  listPinnedDirectoryEntries,
  mkdirPinnedWorkspaceEntry,
  openPinnedWorkspaceEntry,
  removePinnedWorkspaceTree,
  renamePinnedWorkspaceEntryExclusive,
  renamePinnedWorkspaceEntryExclusiveBetween,
  unlinkPinnedWorkspaceEntry,
  withCreatedPinnedWorkspaceParent,
  withPinnedWorkspaceParent,
} from "./native-fs";

const SECRET_SEGMENTS = new Set([".env", ".ssh", ".gnupg", ".aws", ".npmrc", ".pypirc"]);
const SECRET_SUFFIXES = [".pem", ".key", ".p12", ".pfx"];

export function isSecretWorkspacePath(relativePath: string): boolean {
  const normalized = relativePath.toLowerCase().replaceAll("\\", "/");
  const segments = normalized.split("/");
  return segments.some((segment) => SECRET_SEGMENTS.has(segment))
    || SECRET_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
    || segments.includes(".git");
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

  readText(input: string, maxBytes: number): { text: string; byteSize: number; truncated: boolean } {
    const result = this.readBytes(input, maxBytes);
    if (result.bytes.includes(0)) throw new Error("workspace_binary_file");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
    } catch {
      throw new Error("workspace_non_utf8_file");
    }
    return { text, byteSize: result.byteSize, truncated: result.truncated };
  }

  readBytes(input: string, maxBytes: number): { bytes: Buffer; byteSize: number; truncated: boolean } {
    const resolved = this.resolveExisting(input);
    this.assertNotSecret(resolved.relativePath);
    const before = lstatSync(resolved.absolutePath);
    if (!before.isFile()) throw new Error("workspace_not_file");
    if (before.nlink > 1) throw new Error("workspace_hardlink_denied");
    const fd = openSync(resolved.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("workspace_file_changed");
      const limit = Math.max(1, Math.min(maxBytes, 25 * 1024 * 1024));
      const bytes = Buffer.alloc(Math.min(opened.size, limit) + (opened.size > limit ? 0 : 1));
      const read = readSync(fd, bytes, 0, Math.min(opened.size, limit), 0);
      return { bytes: bytes.subarray(0, read), byteSize: opened.size, truncated: opened.size > limit };
    } finally {
      closeSync(fd);
    }
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

  writeText(input: string, content: string): { relativePath: string; existed: boolean } {
    const resolved = this.resolveMutationTarget(input);
    if (existsSync(resolved.absolutePath)) {
      const before = lstatSync(resolved.absolutePath);
      if (!before.isFile()) throw new Error("workspace_not_file");
      if (before.nlink > 1) throw new Error("workspace_hardlink_denied");
      withPinnedWorkspaceParent(this.canonicalRoot, resolved.relativePath, (parentFd, basename) => {
        const fd = openPinnedWorkspaceEntry(parentFd, basename, constants.O_WRONLY);
        try {
          const opened = fstatSync(fd);
          if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("workspace_file_changed");
          if (opened.nlink > 1) throw new Error("workspace_hardlink_denied");
          ftruncateSync(fd, 0);
          writeFileSync(fd, content, "utf-8");
        } finally {
          closeSync(fd);
        }
      });
      return { relativePath: resolved.relativePath, existed: true };
    }

    withCreatedPinnedWorkspaceParent(this.canonicalRoot, resolved.relativePath, (parentFd, basename) => {
      const fd = openPinnedWorkspaceEntry(
        parentFd,
        basename,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile()) throw new Error("workspace_not_file");
        if (opened.nlink > 1) throw new Error("workspace_hardlink_denied");
        writeFileSync(fd, content, "utf-8");
      } finally {
        closeSync(fd);
      }
    });
    return { relativePath: resolved.relativePath, existed: false };
  }

  createDirectory(input: string): { path: string } {
    const resolved = this.resolveMutationTarget(input);
    withCreatedPinnedWorkspaceParent(this.canonicalRoot, resolved.relativePath, (parentFd, basename) => {
      mkdirPinnedWorkspaceEntry(parentFd, basename);
    });
    return { path: resolved.relativePath };
  }

  createFile(input: string, bytes: Uint8Array): { path: string; byteSize: number } {
    const resolved = this.resolveMutationTarget(input);
    withCreatedPinnedWorkspaceParent(this.canonicalRoot, resolved.relativePath, (parentFd, basename) => {
      const stagingName = `.socrates-create-${crypto.randomUUID()}`;
      let staged = false;
      try {
        const fd = openPinnedWorkspaceEntry(
          parentFd,
          stagingName,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        );
        staged = true;
        try {
          const opened = fstatSync(fd);
          if (!opened.isFile()) throw new Error("workspace_not_file");
          if (opened.nlink > 1) throw new Error("workspace_hardlink_denied");
          writeFileSync(fd, bytes);
        } finally {
          closeSync(fd);
        }
        renamePinnedWorkspaceEntryExclusive(parentFd, stagingName, basename);
        staged = false;
      } catch (error) {
        if (staged) {
          try {
            unlinkPinnedWorkspaceEntry(parentFd, stagingName, false);
          } catch {
            // Never replace or delete the requested destination during cleanup.
          }
        }
        throw error;
      }
    });
    return { path: resolved.relativePath, byteSize: bytes.byteLength };
  }

  createTree(input: string, snapshot: WorkspaceTreeSnapshot): {
    path: string;
    entries: number;
    byteSize: number;
  } {
    if (snapshot.kind !== "directory") throw new Error("workspace_tree_not_directory");
    const resolved = this.resolveMutationTarget(input);
    withCreatedPinnedWorkspaceParent(this.canonicalRoot, resolved.relativePath, (parentFd, basename) => {
      const stagingName = `.socrates-tree-${crypto.randomUUID()}`;
      const separator = resolved.relativePath.lastIndexOf("/");
      const parentRelative = separator < 0 ? "" : resolved.relativePath.slice(0, separator);
      const stagingRelative = parentRelative ? `${parentRelative}/${stagingName}` : stagingName;
      let staged = false;
      try {
        mkdirPinnedWorkspaceEntry(parentFd, stagingName);
        staged = true;
        for (const entry of snapshot.entries) {
          const target = `${stagingRelative}/${entry.path}`;
          if (entry.kind === "directory") this.createDirectory(target);
          else this.createFile(target, entry.bytes);
        }
        renamePinnedWorkspaceEntryExclusive(parentFd, stagingName, basename);
        staged = false;
      } catch (error) {
        if (staged) {
          try {
            removePinnedWorkspaceTree(parentFd, stagingName);
          } catch {
            // Preserve a quarantined staging tree if its identity cannot be
            // verified safely; never touch the requested destination.
          }
        }
        throw error;
      }
    });
    return {
      path: resolved.relativePath,
      entries: snapshot.entries.length,
      byteSize: snapshot.totalBytes,
    };
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

  movePath(input: string, destination: string): { from: string; to: string; kind: "file" | "directory" } {
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
        renamePinnedWorkspaceEntryExclusiveBetween(sourceParentFd, sourceName, targetParentFd, targetName);
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

  deletePath(input: string): { path: string; kind: "file" | "directory" } {
    const target = this.inspectDeletionTarget(input);
    withPinnedWorkspaceParent(this.canonicalRoot, target.relativePath, (parentFd, basename) => {
      const quarantineName = `.socrates-delete-${crypto.randomUUID()}`;
      renamePinnedWorkspaceEntryExclusive(parentFd, basename, quarantineName);
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
        unlinkPinnedWorkspaceEntry(parentFd, quarantineName, target.kind === "directory");
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
