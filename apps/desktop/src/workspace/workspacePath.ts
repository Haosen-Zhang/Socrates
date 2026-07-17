export function relativeWorkspacePath(canonicalRoot: string, absolutePath: string): string {
  const root = canonicalRoot.replace(/\/+$/u, "");
  if (!absolutePath.startsWith(`${root}/`)) throw new Error("file_outside_workspace");
  const relative = absolutePath.slice(root.length + 1);
  if (!relative || relative.split("/").includes("..")) throw new Error("file_outside_workspace");
  return relative;
}
