import type { ModelCapabilities } from "./model-capabilities";
import type { NormalizedUsage } from "./usage";
import type { MessagePart, ToolOutputRef } from "./message-parts";
import type { ToolRisk } from "./tools";

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
  | { type: "tool_result"; callId: string; name: string; output: ToolOutputRef; isError: boolean }
  | { type: "approval_required"; requestId: string; callId: string; risk?: ToolRisk; kind?: string; policyVersion?: number; freshHumanRequired?: boolean }
  | { type: "usage"; usage: NormalizedUsage }
  | { type: "status"; status: RuntimeStatus; message?: string }
  | { type: "extension"; name: string; payload: unknown };

/**
 * Provider-neutral, product-owned conversation context.
 *
 * This is deliberately separate from provider SDK message types: Socrates
 * reloads it from the local ConversationMemoryStore for every Turn, then each
 * runtime adapter converts it to its provider-specific payload.
 */
export interface RuntimeConversationMessage {
  messageId: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  parts: MessagePart[];
  sequence: number;
}

export interface AgentRuntime {
  readonly kind: string;
  readonly capabilities: ModelCapabilities;
  /** Conservative provider-input overhead for tool names/descriptions/schemas. */
  contextOverheadTokens?(): number;
  open(input: { sessionId: string; workspaceId?: string }): Promise<void>;
  start(input: {
    prompt: string;
    parts?: MessagePart[];
    messages?: RuntimeConversationMessage[];
    signal?: AbortSignal;
  }): AsyncIterable<RuntimeEvent>;
  answerApproval(requestId: string, decision: "allow_once" | "allow_session" | "deny"): Promise<void>;
  interrupt(): Promise<void>;
  resume?(): Promise<void>;
  close(): Promise<void>;
}
