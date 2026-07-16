import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { normalizeWorkspaceRelativePath } from "@socrates/core";

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

  readText(input: string, maxBytes: number): { text: string; byteSize: number; truncated: boolean } {
    const resolved = this.resolveExisting(input);
    this.assertNotSecret(resolved.relativePath);
    const before = lstatSync(resolved.absolutePath);
    if (!before.isFile()) throw new Error("workspace_not_file");
    if (before.nlink > 1) throw new Error("workspace_hardlink_denied");
    const fd = openSync(resolved.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("workspace_file_changed");
      const limit = Math.max(1, Math.min(maxBytes, 4 * 1024 * 1024));
      const bytes = Buffer.alloc(Math.min(opened.size, limit) + (opened.size > limit ? 0 : 1));
      const read = readSync(fd, bytes, 0, Math.min(opened.size, limit), 0);
      const content = bytes.subarray(0, read);
      if (content.includes(0)) throw new Error("workspace_binary_file");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(content);
      } catch {
        throw new Error("workspace_non_utf8_file");
      }
      return { text, byteSize: opened.size, truncated: opened.size > limit };
    } finally {
      closeSync(fd);
    }
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

export function nearestExistingParent(path: string): string {
  let cursor = path;
  for (;;) {
    try {
      realpathSync(cursor);
      return cursor;
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error("workspace_parent_not_found");
      cursor = parent;
    }
  }
}
