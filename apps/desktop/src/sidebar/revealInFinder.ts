import type { ConversationSession, WorkspaceRecord } from "@socrates/core";

export type SidebarRevealTarget = {
  kind: "room" | "session" | "workspace";
  id: string;
};

export type SidebarRevealResolution =
  | { status: "ready"; path: string }
  | { status: "missing"; workspaceId: string };

export function resolveSidebarRevealPath(
  target: SidebarRevealTarget,
  sessions: readonly Pick<ConversationSession, "id" | "workspaceId">[],
  workspaces: readonly Pick<WorkspaceRecord, "id" | "canonicalPath">[],
): SidebarRevealResolution | null {
  const workspaceId = target.kind === "workspace"
    ? target.id
    : target.kind === "session"
      ? sessions.find((session) => session.id === target.id)?.workspaceId
      : null;
  if (!workspaceId) return null;
  const path = workspaces.find((workspace) => workspace.id === workspaceId)?.canonicalPath.trim();
  return path
    ? { status: "ready", path }
    : { status: "missing", workspaceId };
}

export async function revealPathInFinder(path: string): Promise<void> {
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

export async function revealResolvedSidebarTarget(
  target: SidebarRevealResolution,
  reveal: (path: string) => Promise<void> = revealPathInFinder,
): Promise<void> {
  if (target.status === "missing") throw new Error("workspace_not_found");
  await reveal(target.path);
}
