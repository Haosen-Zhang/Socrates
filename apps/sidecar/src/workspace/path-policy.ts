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
  openPinnedWorkspaceEntry,
  renamePinnedWorkspaceEntryExclusive,
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

export type DeletionTarget = ResolvedWorkspacePath & {
  kind: "file" | "directory";
  dev: number;
  ino: number;
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
