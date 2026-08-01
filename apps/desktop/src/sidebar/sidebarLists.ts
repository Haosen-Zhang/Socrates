import type { NavRoom, NavWorkspace } from "@socrates/core";

/** A room projected into the single sidebar, regardless of its legacy source. */
export type SidebarRoom = NavRoom & { name: string };

export type WorkspaceGroup = {
  workspace: NavWorkspace & { label: string };
  rooms: SidebarRoom[];
};

/**
 * Compatibility bucket for historical rooms that predate workspace binding.
 * They stay reachable without exposing their old Chat product type.
 */
export function topLevelRooms(
  rooms: SidebarRoom[],
  workspaces: Array<NavWorkspace>,
): SidebarRoom[] {
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  return rooms.filter(
    (room) => !room.archived && (room.workspaceId === null || !workspaceIds.has(room.workspaceId)),
  );
}

/**
 * One workspace tree for every workspace-bound room. An archived workspace
 * remains visible while it still owns a live room so that room cannot become
 * unreachable.
 */
export function workspaceGroups(
  rooms: SidebarRoom[],
  workspaces: Array<NavWorkspace & { label: string }>,
): WorkspaceGroup[] {
  return workspaces
    .map((workspace) => ({
      workspace,
      rooms: rooms.filter(
        (room) => !room.archived && room.workspaceId === workspace.id,
      ),
    }))
    .filter((group) => !group.workspace.archived || group.rooms.length > 0);
}

export type SearchHit =
  | { kind: "room"; room: SidebarRoom }
  | { kind: "workspace"; workspaceId: string; label: string };

const matches = (haystack: string, needle: string) => haystack.toLowerCase().includes(needle);

/** Search every visible room and workspace without a top-level mode filter. */
export function searchSidebar(
  query: string,
  data: {
    rooms: SidebarRoom[];
    workspaces: Array<NavWorkspace & { label: string; path?: string }>;
    memberNamesByRoom?: Record<string, string[]>;
  },
): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const memberNames = data.memberNamesByRoom ?? {};

  const workspaceHits: SearchHit[] = data.workspaces
    .filter(
      (workspace) =>
        !workspace.archived && (matches(workspace.label, needle) || matches(workspace.path ?? "", needle)),
    )
    .map((workspace) => ({ kind: "workspace" as const, workspaceId: workspace.id, label: workspace.label }));

  const roomHits: SearchHit[] = data.rooms
    .filter(
      (room) =>
        !room.archived &&
        (matches(room.name, needle) || (memberNames[room.id] ?? []).some((name) => matches(name, needle))),
    )
    .map((room) => ({ kind: "room" as const, room }));

  return [...workspaceHits, ...roomHits];
}
