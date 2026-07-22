import type { RoomKind } from "./room-kind";

/**
 * 导航单一事实来源（C2）。
 *
 * 旧模型有四个可独立变化的状态：`view` / `currentRoomId` / `currentSessionId` /
 * 全局粘性 `activeWorkspace`。它们能组合出非法状态——最典型的是
 * 「Chat 房间打开着，同时全局 workspace 被高亮」，于是 Chat 看起来继承了工作区。
 *
 * 新模型：任意时刻只有一个 primary target；workspace **只能**从 target 派生，
 * 不再有独立的全局 activeWorkspaceId。
 *
 * Settings 不在此联合类型内，而是独立的 overlay：它必须能在关闭后回到原 target，
 * 若把它当作 primary target 就会覆盖掉「用户原本在哪」这一信息。
 */
export type NavigationTarget =
  | { kind: "chat_room"; roomId: string }
  | { kind: "cowork_room"; roomId: string; workspaceId: string }
  | { kind: "cowork_workspace"; workspaceId: string };

export type AppMode = "chat" | "cowork";

/** 供导航解析使用的最小房间视图（core 保持零 IO） */
export type NavRoom = { id: string; kind: RoomKind; workspaceId: string | null; archived: boolean };
export type NavWorkspace = { id: string; archived: boolean };

/** 顶层模式由当前 target 派生，不再单独存一份可能不同步的副本。 */
export function modeOfTarget(target: NavigationTarget | null): AppMode {
  return target?.kind === "chat_room" ? "chat" : target ? "cowork" : "chat";
}

/**
 * 当前 target 对应的工作区。Chat **永远**返回 null——
 * 这是「Chat 不得隐式继承 workspace」在代码里的唯一执行点。
 */
export function workspaceOfTarget(target: NavigationTarget | null): string | null {
  if (!target || target.kind === "chat_room") return null;
  return target.workspaceId;
}

/** 从房间构造 target：cowork 的 workspace 只来自房间持久化字段。 */
export function targetForRoom(room: NavRoom): NavigationTarget | null {
  if (room.kind === "chat") return { kind: "chat_room", roomId: room.id };
  if (!room.workspaceId) return null; // 缺 workspace 的 cowork 需先走恢复流程
  return { kind: "cowork_room", roomId: room.id, workspaceId: room.workspaceId };
}

/**
 * 校验 target 在当前数据下是否合法（用于恢复与删除后的兜底）。
 * 非法情形：引用了不存在/已归档的实体，或 room 的 kind/workspace 与 target 不符。
 */
export function isTargetValid(
  target: NavigationTarget,
  data: { rooms: NavRoom[]; workspaces: NavWorkspace[] },
): boolean {
  const liveWorkspace = (id: string) => data.workspaces.some((w) => w.id === id && !w.archived);
  if (target.kind === "cowork_workspace") return liveWorkspace(target.workspaceId);

  const room = data.rooms.find((r) => r.id === target.roomId && !r.archived);
  if (!room) return false;
  if (target.kind === "chat_room") return room.kind === "chat" && room.workspaceId === null;
  return room.kind === "cowork" && room.workspaceId === target.workspaceId && liveWorkspace(target.workspaceId);
}

/**
 * 恢复/删除后的兜底：优先修好当前 target，否则在**同一模式**内挑一个合法目标，
 * 再不行退到另一模式，最后返回 null（空态）。绝不返回非法组合。
 */
export function repairTarget(
  target: NavigationTarget | null,
  data: { rooms: NavRoom[]; workspaces: NavWorkspace[] },
): NavigationTarget | null {
  if (target && isTargetValid(target, data)) return target;

  const preferred: AppMode = modeOfTarget(target);
  const live = data.rooms.filter((room) => !room.archived);
  const pick = (mode: AppMode): NavigationTarget | null => {
    for (const room of live.filter((room) => (mode === "chat" ? room.kind === "chat" : room.kind === "cowork"))) {
      const candidate = targetForRoom(room);
      if (candidate && isTargetValid(candidate, data)) return candidate;
    }
    if (mode === "cowork") {
      const workspace = data.workspaces.find((w) => !w.archived);
      if (workspace) return { kind: "cowork_workspace", workspaceId: workspace.id };
    }
    return null;
  };
  return pick(preferred) ?? pick(preferred === "chat" ? "cowork" : "chat");
}

/**
 * 切换顶层模式：不修改任何房间的持久化类型或绑定，只是把 target 移到该模式下的
 * 一个合法目标（记忆上次位置由调用方决定）。
 */
export function targetForMode(
  mode: AppMode,
  data: { rooms: NavRoom[]; workspaces: NavWorkspace[] },
  remembered: NavigationTarget | null,
): NavigationTarget | null {
  if (remembered && modeOfTarget(remembered) === mode && isTargetValid(remembered, data)) return remembered;
  return repairTarget(mode === "chat" ? { kind: "chat_room", roomId: "" } : { kind: "cowork_workspace", workspaceId: "" }, data);
}
