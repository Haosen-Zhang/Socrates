import type { WorkspaceRecord } from "@socrates/core";

/** Keep "no project" as a real state; never silently substitute the first known folder. */
export function resolveActiveWorkspace(
  workspaces: WorkspaceRecord[],
  current: WorkspaceRecord | null,
  persistedId: string | null,
): WorkspaceRecord | null {
  const currentMatch = current && workspaces.find((workspace) => workspace.id === current.id && !workspace.archived);
  if (currentMatch) return currentMatch;
  return persistedId ? workspaces.find((workspace) => workspace.id === persistedId && !workspace.archived) ?? null : null;
}

/** Empty titles are intentional for quick chats; the UI supplies a localized default. */
export function roomTitleOrFallback(title: string, fallback: string): string {
  return title.trim() || fallback;
}
