import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isSecretWorkspacePath, WorkspacePathPolicy } from "./path-policy";

export interface WorkspaceSearchResult { relativePath: string; kind: "file" | "directory" }

export function searchWorkspacePaths(root: string, query: string, maxResults = 50): WorkspaceSearchResult[] {
  const policy = new WorkspacePathPolicy(root);
  const needle = query.trim().toLowerCase();
  const queue = [{ absolute: policy.canonicalRoot, relative: "" }];
  const results: WorkspaceSearchResult[] = [];
  let visited = 0;
  while (queue.length && results.length < Math.min(maxResults, 200) && visited < 5_000) {
    const current = queue.shift()!;
    for (const name of readdirSync(current.absolute).sort()) {
      visited += 1;
      const relativePath = [current.relative, name].filter(Boolean).join("/");
      if (isSecretWorkspacePath(relativePath)) continue;
      const absolute = join(current.absolute, name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) continue;
      const kind = stat.isDirectory() ? "directory" as const : "file" as const;
      if (!needle || relativePath.toLowerCase().includes(needle)) results.push({ relativePath, kind });
      if (stat.isDirectory()) queue.push({ absolute, relative: relativePath });
      if (results.length >= maxResults || visited >= 5_000) break;
    }
  }
  return results;
}
