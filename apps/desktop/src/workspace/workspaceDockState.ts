export type WorkspaceDockMode = "closed" | "files" | "diff";

export function toggleWorkspaceDock(
  current: WorkspaceDockMode,
  requested: Exclude<WorkspaceDockMode, "closed">,
  hasWorkspace: boolean,
): WorkspaceDockMode {
  if (!hasWorkspace) return "closed";
  return current === requested ? "closed" : requested;
}
