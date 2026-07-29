export type ConversationMode = "chat" | "single_agent" | "multi_agent";

export type AgentRunPhase =
  | "idle"
  | "preparing"
  | "discussing"
  | "synthesizing"
  | "awaiting_plan_approval"
  | "revising_plan"
  | "executing"
  | "awaiting_tool_approval"
  | "paused"
  | "failed"
  | "cancelled"
  | "completed";

export type ToolCapability = "workspace_read" | "workspace_write" | "shell" | "network" | "mcp";

export interface SessionAgentSnapshot {
  agentId: string;
  snapshot: Record<string, unknown>;
  position: number;
  executionEligible: boolean;
}

export interface ConversationSession {
  id: string;
  title: string;
  mode: ConversationMode;
  /** 新房间模型（C1）；mode 保留为运行时形态，kind 决定导航归属 */
  kind: import("./room-kind").RoomKind;
  /** 协作治理设置（讨论/协作/Boss/审批/监督）；chat 恒为默认值 */
  collaboration: import("./room-kind").RoomCollaborationSettings;
  workspaceId: string | null;
  /** Explicit default executor. Never infer this from session_agents position. */
  primaryAgentId: string;
  archived: boolean;
  status: string;
  legacyRoomId: string | null;
  agents: SessionAgentSnapshot[];
  createdAt: string;
  updatedAt: string;
}

export interface SessionMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  authorId: string | null;
  content: string;
  status: string;
  createdAt: string;
  parts: import("./message-parts").MessagePart[];
}

export function validateConversation(input: { mode: ConversationMode; agentIds: string[] }): string[] {
  if (input.mode === "single_agent" && input.agentIds.length !== 1) return ["single_agent_requires_one_agent"];
  if (input.mode === "multi_agent" && input.agentIds.length < 2) return ["multi_agent_requires_multiple_agents"];
  return [];
}

export function modeToolCeiling(mode: ConversationMode, phase: AgentRunPhase): ToolCapability[] {
  if (mode === "chat") return [];
  if (mode === "multi_agent" && (phase === "discussing" || phase === "synthesizing")) return ["workspace_read"];
  if (mode === "multi_agent" && phase !== "executing" && phase !== "awaiting_tool_approval") return [];
  return ["workspace_read", "workspace_write", "shell", "network", "mcp"];
}
