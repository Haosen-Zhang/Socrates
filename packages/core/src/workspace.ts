export interface WorkspaceRecord {
  id: string;
  canonicalPath: string;
  displayPath: string;
  identityHash: string;
  label: string;
  ownership: "external" | "managed";
  ownerSessionId: string | null;
  archived: boolean;
  createdAt: string;
  lastOpenedAt: string;
}

export interface WorkspaceCapability {
  workspaceId: string;
  identityHash: string;
  access: "read" | "write";
}

export interface WorkspaceRef {
  id: string;
  workspaceId: string;
  relativePath: string;
  kind: "file" | "directory";
  snapshotHash: string | null;
  snapshotSize: number | null;
}

export interface WorkspaceBrowserEntry {
  name: string;
  relativePath: string;
  kind: "file" | "directory";
}

export interface WorkspaceDirectoryListing {
  path: string;
  entries: WorkspaceBrowserEntry[];
  truncated: boolean;
}

export interface WorkspaceFilePreview {
  relativePath: string;
  text: string;
  byteSize: number;
  truncated: boolean;
}

export type WorkspaceGitFileStatus = "added" | "deleted" | "modified" | "renamed" | "untracked";

export interface WorkspaceGitStatus {
  state: "ready" | "not_git";
  files: Array<{ relativePath: string; status: WorkspaceGitFileStatus }>;
  truncated: boolean;
}

export interface WorkspaceGitDiff {
  relativePath: string;
  patch: string;
  binary: boolean;
  truncated: boolean;
}

export function normalizeWorkspaceRelativePath(input: string): string {
  if (input.includes("\0")) throw new Error("workspace_path_contains_null");
  const portable = input.split("\\").join("/");
  if (portable.startsWith("/") || /^[A-Za-z]:\//.test(portable)) throw new Error("workspace_path_must_be_relative");
  const output: string[] = [];
  for (const part of portable.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error("workspace_path_traversal");
    output.push(part);
  }
  return output.join("/");
}
