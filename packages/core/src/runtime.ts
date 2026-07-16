import type { ModelCapabilities } from "./model-capabilities";
import type { NormalizedUsage } from "./usage";

export type RuntimeStatus = "opening" | "ready" | "running" | "awaiting_approval" | "interrupted" | "completed" | "failed" | "closed";

const transitions: Record<RuntimeStatus, RuntimeStatus[]> = {
  opening: ["ready", "failed", "closed"],
  ready: ["running", "closed", "failed"],
  running: ["awaiting_approval", "interrupted", "completed", "failed", "closed"],
  awaiting_approval: ["running", "interrupted", "failed", "closed"],
  interrupted: ["running", "failed", "closed"],
  completed: ["closed"],
  failed: ["closed"],
  closed: [],
};

export function runtimeTransitionAllowed(from: RuntimeStatus, to: RuntimeStatus): boolean {
  return transitions[from].includes(to);
}

export function isTerminalRuntimeStatus(status: RuntimeStatus): boolean {
  return status === "completed" || status === "failed" || status === "closed";
}

export type RuntimeEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; callId: string; name: string; input: unknown }
  | { type: "approval_required"; requestId: string; callId: string }
  | { type: "usage"; usage: NormalizedUsage }
  | { type: "status"; status: RuntimeStatus; message?: string }
  | { type: "extension"; name: string; payload: unknown };

export interface AgentRuntime {
  readonly kind: string;
  readonly capabilities: ModelCapabilities;
  open(input: { sessionId: string; workspaceId?: string }): Promise<void>;
  start(input: { prompt: string; signal?: AbortSignal }): AsyncIterable<RuntimeEvent>;
  answerApproval(requestId: string, decision: "allow_once" | "allow_session" | "deny"): Promise<void>;
  interrupt(): Promise<void>;
  resume?(): Promise<void>;
  close(): Promise<void>;
}
