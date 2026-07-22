import type { ConversationMode, RoomKind } from "@socrates/core";

export function toggleRoomAgentSelection(selected: string[], agentId: string): string[] {
  return selected.includes(agentId)
    ? selected.filter((id) => id !== agentId)
    : [...selected, agentId];
}

/**
 * 建房草稿（C4）：两张卡片 Chat / Co-work，两者都支持 1..N 成员。
 *
 * 唯一的结构差异是工作区：Chat 永不绑定（payload 显式发 `workspaceId: null`，
 * 而不是「省略字段让后端猜」），Co-work 必须由用户在对话框里明确选一个——
 * 不再从全局 activeWorkspace 隐式继承，否则换房间会带着上一个工作区跑。
 */
export type RoomDraft = {
  kind: RoomKind;
  title: string;
  agentIds: string[];
  /** 仅 Co-work 有意义；Chat 恒为 null */
  workspaceId: string | null;
};

/** 阻止提交的原因；null 表示可以建。 */
export function roomDraftBlocker(draft: RoomDraft): string | null {
  if (draft.agentIds.length < 1) return "room_requires_member";
  if (draft.kind === "chat") return null;
  return draft.workspaceId ? null : "cowork_room_requires_workspace";
}

/** 草稿 → 后端 payload。mode 由 kind + 人数派生，前端不再各自拼。 */
export function roomCreatePayload(draft: RoomDraft): {
  kind: RoomKind;
  mode: ConversationMode;
  workspaceId: string | null;
  agentIds: string[];
} {
  const isChat = draft.kind === "chat";
  return {
    kind: draft.kind,
    mode: isChat ? "chat" : draft.agentIds.length > 1 ? "multi_agent" : "single_agent",
    workspaceId: isChat ? null : draft.workspaceId,
    agentIds: draft.agentIds,
  };
}
