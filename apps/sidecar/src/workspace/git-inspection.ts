import type { ToolContext, WorkspaceGitDiff, WorkspaceGitFileStatus, WorkspaceGitStatus } from "@socrates/core";
import { normalizeWorkspaceRelativePath } from "@socrates/core";
import { SupervisedCommandRunner } from "../tools/workspace-command-runner";
import { isSecretWorkspacePath, WorkspacePathPolicy } from "./path-policy";

const MAX_STATUS_FILES = 500;
const MAX_STATUS_BYTES = 256 * 1024;
const MAX_PATCH_BYTES = 2 * 1024 * 1024;

function runner(limit: number): SupervisedCommandRunner {
  return new SupervisedCommandRunner((workspaceRoot, input) => ({
    executable: "/usr/bin/git",
    argv: input.argv,
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: workspaceRoot,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      NO_COLOR: "1",
    },
  }), limit);
}

function context(): ToolContext {
  return {
    callId: "workspace-inspection",
    sessionId: "workspace-inspection",
    taskId: "workspace-inspection",
    turnId: "workspace-inspection",
    agentId: "workspace-inspection",
    mode: "single_agent",
    phase: "executing",
    signal: new AbortController().signal,
  };
}

async function git(policy: WorkspacePathPolicy, argv: string[], limit: number) {
  return runner(limit).run(policy.canonicalRoot, { executable: "git", argv, timeoutMs: 5_000 }, context());
}

function classify(code: string): WorkspaceGitFileStatus {
  if (code === "??") return "untracked";
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  if (code.includes("A")) return "added";
  return "modified";
}

function statusPath(line: string): string | null {
  const raw = line.slice(3).replace(/^.* -> /u, "");
  try {
    const relativePath = normalizeWorkspaceRelativePath(raw);
    return relativePath && !isSecretWorkspacePath(relativePath) ? relativePath : null;
  } catch {
    return null;
  }
}

export async function inspectWorkspaceGitStatus(policy: WorkspacePathPolicy): Promise<WorkspaceGitStatus> {
  const check = await git(policy, ["rev-parse", "--is-inside-work-tree"], 1024);
  if (check.exitCode !== 0 || check.stdout.trim() !== "true") return { state: "not_git", files: [], truncated: false };
  const result = await git(policy, ["-c", "core.quotepath=false", "status", "--porcelain=v1", "--untracked-files=all", "--", "."], MAX_STATUS_BYTES);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "workspace_git_status_failed");
  const files = result.stdout.split("\n").filter(Boolean).flatMap((line) => {
    const relativePath = statusPath(line);
    return relativePath ? [{ relativePath, status: classify(line.slice(0, 2)) }] : [];
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return {
    state: "ready",
    files: files.slice(0, MAX_STATUS_FILES),
    truncated: result.stdoutTruncated || files.length > MAX_STATUS_FILES,
  };
}

export async function inspectWorkspaceGitDiff(policy: WorkspacePathPolicy, input: string): Promise<WorkspaceGitDiff> {
  const relativePath = normalizeWorkspaceRelativePath(input);
  if (!relativePath) throw new Error("relative_path_required");
  if (isSecretWorkspacePath(relativePath)) throw new Error("workspace_secret_path_denied");
  const status = await inspectWorkspaceGitStatus(policy);
  if (status.state !== "ready") throw new Error("workspace_not_git");
  const changed = status.files.find((file) => file.relativePath === relativePath);
  if (!changed) throw new Error("workspace_git_path_unchanged");

  const argv = changed.status === "untracked"
    ? ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--unified=3", "--", "/dev/null", relativePath]
    : ["diff", "HEAD", "--no-ext-diff", "--no-textconv", "--unified=3", "--", relativePath];
  if (changed.status === "untracked") policy.resolveExisting(relativePath);
  const result = await git(policy, argv, MAX_PATCH_BYTES);
  if (result.exitCode > 1) throw new Error(result.stderr.trim() || "workspace_git_diff_failed");
  return {
    relativePath,
    patch: result.stdout,
    truncated: result.stdoutTruncated,
    binary: /(?:^|\n)(?:Binary files .* differ|GIT binary patch)(?:\n|$)/u.test(result.stdout),
  };
}
