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
  workspaceId: string | null;
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
