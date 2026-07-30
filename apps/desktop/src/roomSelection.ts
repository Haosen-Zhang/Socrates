import type { ConversationMode, RoomKind, WorkspaceRecord } from "@socrates/core";

export function toggleRoomAgentSelection(selected: string[], agentId: string): string[] {
  return selected.includes(agentId)
    ? selected.filter((id) => id !== agentId)
    : [...selected, agentId];
}

export function isOwnedManagedWorkspace(
  workspace: WorkspaceRecord | undefined,
  sessionId: string,
): boolean {
  return workspace?.ownership === "managed" && workspace.ownerSessionId === sessionId;
}

export type WorkspaceSelection =
  | { kind: "managed" }
  | { kind: "existing"; workspaceId: string | null };

/** New rooms have one working-room shape. Runtime mode is derived from members. */
export type RoomDraft = {
  title: string;
  agentIds: string[];
  /** Chosen once during creation and persisted; never re-derived from member order. */
  primaryAgentId: string | null;
  workspaceSelection: WorkspaceSelection;
};

/** 阻止提交的原因；null 表示可以建。 */
export function roomDraftBlocker(draft: RoomDraft): string | null {
  if (draft.agentIds.length < 1) return "room_requires_member";
  if (!draft.primaryAgentId || !draft.agentIds.includes(draft.primaryAgentId)) {
    return "room_requires_primary_agent";
  }
  if (draft.workspaceSelection.kind === "existing" && !draft.workspaceSelection.workspaceId) {
    return "room_requires_workspace";
  }
  return null;
}

/** 草稿 → 后端 payload。mode 由 kind + 人数派生，前端不再各自拼。 */
export function roomCreatePayload(draft: RoomDraft): {
  kind: RoomKind;
  mode: ConversationMode;
  workspaceSelection: WorkspaceSelection;
  agentIds: string[];
  primaryAgentId: string;
} {
  if (!draft.primaryAgentId) throw new Error("room_requires_primary_agent");
  return {
    kind: "cowork",
    mode: draft.agentIds.length > 1 ? "multi_agent" : "single_agent",
    workspaceSelection: draft.workspaceSelection,
    agentIds: draft.agentIds,
    primaryAgentId: draft.primaryAgentId,
  };
}
