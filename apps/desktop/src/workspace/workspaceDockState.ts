export type WorkspaceDockMode = "closed" | "overview" | "files" | "diff";

export function toggleWorkspaceDock(
  current: WorkspaceDockMode,
  requested: Exclude<WorkspaceDockMode, "closed">,
  hasWorkspace: boolean,
): WorkspaceDockMode {
  if (requested !== "overview" && !hasWorkspace) return "closed";
  return current === requested ? "closed" : requested;
}
