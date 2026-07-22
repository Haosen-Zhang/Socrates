import type { AppMode, NavRoom, NavWorkspace } from "@socrates/core";

/**
 * 侧栏列表与搜索（C3，纯函数）。
 *
 * 关键不变量：列表按顶层模式过滤——Chat 房间绝不出现在 Co-work 的工作区树里，
 * Co-work 房间也绝不出现在 Chat 列表中。**展开与选中是两件事**，展开状态由调用方
 * 单独持有，本模块只负责「有哪些内容」。
 */
export type SidebarRoom = NavRoom & { name: string };

export type WorkspaceGroup = {
  workspace: NavWorkspace & { label: string };
  rooms: SidebarRoom[];
};

/** Chat 模式：只有未归档的 chat 房间，扁平列表。 */
export function chatRooms(rooms: SidebarRoom[]): SidebarRoom[] {
  return rooms.filter((room) => room.kind === "chat" && !room.archived);
}

/** Co-work 模式：工作区树，每个工作区下挂它自己绑定的 cowork 房间。 */
export function coworkGroups(
  rooms: SidebarRoom[],
  workspaces: Array<NavWorkspace & { label: string }>,
): WorkspaceGroup[] {
  return workspaces
    .filter((workspace) => !workspace.archived)
    .map((workspace) => ({
      workspace,
      rooms: rooms.filter(
        (room) => room.kind === "cowork" && !room.archived && room.workspaceId === workspace.id,
      ),
    }));
}

export type SearchHit =
  | { kind: "room"; room: SidebarRoom }
  | { kind: "workspace"; workspaceId: string; label: string };

const matches = (haystack: string, needle: string) => haystack.toLowerCase().includes(needle);

/**
 * 搜索范围随顶层模式收窄：Chat 只搜 chat 房间与成员名；
 * Co-work 搜 cowork 房间、工作区名与路径。搜索**不改变**任何持久化关系。
 */
export function searchSidebar(
  query: string,
  mode: AppMode,
  data: {
    rooms: SidebarRoom[];
    workspaces: Array<NavWorkspace & { label: string; path?: string }>;
    memberNamesByRoom?: Record<string, string[]>;
  },
): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const memberNames = data.memberNamesByRoom ?? {};

  if (mode === "chat") {
    return chatRooms(data.rooms)
      .filter(
        (room) =>
          matches(room.name, needle) ||
          (memberNames[room.id] ?? []).some((name) => matches(name, needle)),
      )
      .map((room) => ({ kind: "room" as const, room }));
  }

  const roomHits: SearchHit[] = data.rooms
    .filter(
      (room) =>
        room.kind === "cowork" &&
        !room.archived &&
        (matches(room.name, needle) || (memberNames[room.id] ?? []).some((name) => matches(name, needle))),
    )
    .map((room) => ({ kind: "room" as const, room }));

  const workspaceHits: SearchHit[] = data.workspaces
    .filter(
      (workspace) =>
        !workspace.archived && (matches(workspace.label, needle) || matches(workspace.path ?? "", needle)),
    )
    .map((workspace) => ({ kind: "workspace" as const, workspaceId: workspace.id, label: workspace.label }));

  return [...workspaceHits, ...roomHits];
}
