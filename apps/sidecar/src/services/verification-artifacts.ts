import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { normalizeWorkspaceRelativePath, type ArtifactSnapshot, type VerificationCheck, type VerificationSuggestions } from "@socrates/core";
import { WorkspacePathPolicy, isSecretWorkspacePath } from "../workspace/path-policy";
import { hashToolInput } from "../tools/executor";

const OMIT_DIRECTORIES = new Set(["node_modules", "vendor", "target", "dist", "build", "coverage", ".next", ".cache", ".venv", "__pycache__"]);
const MAX_FILES = 4_000;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
export function verificationPath(path: string): string {
  if (typeof path !== "string" || path.length > 1_000) throw new Error("verification_path_invalid");
  const normalized = normalizeWorkspaceRelativePath(path) || ".";
  if (isSecretWorkspacePath(normalized)) throw new Error("workspace_secret_path_denied");
  return normalized;
}

/** Bounded manifests use the existing pinned-descriptor reader. Secret and
 * dependency directories are explicit exclusions; unsupported entries fail
 * closed instead of silently certifying an incomplete snapshot. */
export function captureVerificationSnapshot(policy: WorkspacePathPolicy, paths: string[]): ArtifactSnapshot {
  const files = new Map<string, ArtifactSnapshot["files"][number]>();
  const excluded = new Set<string>();
  let bytes = 0;
  const visit = (path: string) => {
    if (files.has(path)) return;
    if (files.size >= MAX_FILES) throw new Error("verification_snapshot_too_large");
    let resolved: ReturnType<WorkspacePathPolicy["resolveExisting"]>;
    try { resolved = policy.resolveExisting(path); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        policy.resolveMutationTarget(path);
        files.set(path, { path, kind: "missing", sha256: null, byteSize: 0 });
        return;
      }
      throw error;
    }
    const stat = lstatSync(resolved.absolutePath);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && stat.nlink > 1)) throw new Error("verification_unsupported_file_link");
    if (stat.isFile()) {
      if (stat.size > MAX_FILE_BYTES || stat.size > MAX_BYTES - bytes) throw new Error("verification_snapshot_too_large");
      const read = policy.readBytes(path, 1);
      bytes += read.byteSize;
      if (bytes > MAX_BYTES || read.byteSize > MAX_FILE_BYTES) throw new Error("verification_snapshot_too_large");
      files.set(path, { path, kind: "file", sha256: read.sha256, byteSize: read.byteSize });
    } else if (stat.isDirectory()) {
      files.set(path, { path, kind: "directory", sha256: null, byteSize: 0 });
      const names = readdirSync(resolved.absolutePath).sort();
      if (names.length > MAX_FILES - files.size) throw new Error("verification_snapshot_too_large");
      for (const name of names) {
        const child = path === "." ? name : `${path}/${name}`;
        if (isSecretWorkspacePath(child)) { excluded.add(child); continue; }
        const entry = lstatSync(join(resolved.absolutePath, name));
        if (entry.isDirectory() && OMIT_DIRECTORIES.has(name)) { excluded.add(child); continue; }
        visit(child);
      }
    } else throw new Error("verification_unsupported_file_kind");
  };
  const normalized = [...new Set(paths.map(verificationPath))].sort();
  for (const path of normalized) visit(path);
  const manifest = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  const excludedPaths = [...excluded].sort();
  return { paths: normalized, files: manifest, excludedPaths, hash: hashToolInput({ files: manifest, excludedPaths }), createdAt: new Date().toISOString() };
}

export function changedVerificationPaths(before: ArtifactSnapshot, after: ArtifactSnapshot): string[] {
  const previous = new Map(before.files.map(file => [file.path, `${file.kind}:${file.sha256}`]));
  const current = new Map(after.files.map(file => [file.path, `${file.kind}:${file.sha256}`]));
  return [...new Set([...previous.keys(), ...current.keys()])].filter(path => previous.get(path) !== current.get(path)).sort();
}

export function protectedVerificationPaths(snapshot: ArtifactSnapshot): string[] {
  return snapshot.files.filter(file => file.kind === "file" && (
    /(^|\/)(package\.json|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.toml|go\.mod|pyproject\.toml|pytest\.ini|tox\.ini)$/u.test(file.path)
    || /(^|\/)(?:tests?|__tests__|fixtures?|\.github)(?:\/|$)/u.test(file.path)
    || /\.(?:test|spec)\.[^/]+$/u.test(file.path)
    || /(^|\/)(?:tsconfig[^/]*\.json|[^/]*\.config\.[^/]+)$/u.test(file.path)
  )).map(file => file.path);
}

export function discoverVerificationChecks(policy: WorkspacePathPolicy): VerificationSuggestions {
  const snapshot = captureVerificationSnapshot(policy, ["."]);
  const checks: VerificationCheck[] = [];
  const unsupported: string[] = [];
  for (const file of snapshot.files.filter(file => file.path.endsWith("package.json") && file.kind === "file").slice(0, 20)) {
    try {
      const content = policy.readText(file.path, 128 * 1024);
      if (content.truncated) { unsupported.push(`configuration_too_large:${file.path}`); continue; }
      const value = JSON.parse(content.text) as { scripts?: Record<string, unknown> };
      const cwd = file.path.includes("/") ? file.path.slice(0, -13) : ".";
      for (const category of ["test", "typecheck", "build", "lint"] as const) {
        const script = value.scripts?.[category];
        if (typeof script !== "string" || !script.trim()) continue;
        const parser = category !== "test" ? "exit_code" as const : /^bun\s+test(?:\s|$)/u.test(script) ? "bun_test" as const : /\bnode\s+.*--test/u.test(script) && /--test-reporter[= ]tap/u.test(script) ? "tap" as const : "unsupported" as const;
        if (parser === "unsupported") unsupported.push(`test_report_adapter_required:${file.path}`);
        checks.push({ id: `${checks.length + 1}-${category}`, label: `${cwd === "." ? "" : `${cwd}: `}${category}`, required: true, origin: "repository", kind: "command", category,
          command: { executable: "bun", argv: ["run", category], cwd, timeoutMs: 120_000 }, parser, definitionPaths: [file.path] });
      }
    } catch { unsupported.push(`configuration_unreadable:${file.path}`); }
  }
  return { checks: checks.slice(0, 20), artifactPaths: ["."], protectedPaths: protectedVerificationPaths(snapshot), manualJudgment: [], unsupported };
}
