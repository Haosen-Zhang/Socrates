import type { WorkspaceDirectoryListing } from "@socrates/core";
import { WorkspacePathPolicy } from "./path-policy";

const DEFAULT_LIMIT = 500;

export function listWorkspaceDirectory(
  policy: WorkspacePathPolicy,
  input: string,
  maxEntries = DEFAULT_LIMIT,
): WorkspaceDirectoryListing {
  const limit = Math.max(1, Math.min(maxEntries, DEFAULT_LIMIT));
  const resolved = policy.resolveExisting(input || ".");
  const listed = policy.listDirectory(input || ".", limit);
  const entries = listed.entries
    .map((entry) => ({ ...entry, relativePath: [resolved.relativePath, entry.name].filter(Boolean).join("/") }))
    .sort((left, right) => (
      left.kind === right.kind
        ? left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })
        : left.kind === "directory" ? -1 : 1
    ));
  return {
    path: resolved.relativePath,
    entries,
    truncated: listed.truncated,
  };
}
