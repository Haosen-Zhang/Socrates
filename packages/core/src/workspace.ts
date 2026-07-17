export interface WorkspaceRecord {
  id: string;
  canonicalPath: string;
  displayPath: string;
  identityHash: string;
  label: string;
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
