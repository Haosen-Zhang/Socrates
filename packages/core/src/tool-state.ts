/**
 * Tool 状态机 — Socrates Phase 1
 *
 * 每个 Tool Call 独立拥有自己的生命周期。
 * 状态从 proposed 开始，随审批和执行流程迁移。
 */

export type ToolState =
  | "proposed"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export type ToolStateEvent =
  | { type: "request_approval" }
  | { type: "allow"; approved: boolean; allow_session: boolean }
  | { type: "deny" }
  | { type: "execute" }
  | { type: "complete"; success: boolean; error?: string }
  | { type: "timeout" }
  | { type: "cancel" };

export const TOOL_TERMINAL_STATES = new Set<ToolState>(["rejected", "succeeded", "failed", "cancelled", "timed_out"]);

export function isTerminalToolState(state: ToolState): boolean {
  return TOOL_TERMINAL_STATES.has(state);
}

export function reduceToolState(current: ToolState, event: ToolStateEvent): ToolState {
  if (isTerminalToolState(current)) {
    throw new InvalidToolTransitionError(current, event.type);
  }

  const next = ((): ToolState => {
    switch (current) {
      case "proposed":
        if (event.type === "request_approval") return "awaiting_approval";
        if (event.type === "allow" && event.approved) return "approved";
        if (event.type === "execute") return "running"; // no approval needed
        if (event.type === "cancel") return "cancelled";
        break;

      case "awaiting_approval":
        if (event.type === "allow" && event.approved) return "approved";
        if (event.type === "deny" || (event.type === "allow" && !event.approved)) return "rejected";
        if (event.type === "cancel") return "cancelled";
        break;

      case "approved":
        if (event.type === "execute") return "running";
        if (event.type === "cancel") return "cancelled";
        break;

      case "running":
        if (event.type === "complete" && event.success) return "succeeded";
        if (event.type === "complete" && !event.success) return "failed";
        if (event.type === "timeout") return "timed_out";
        if (event.type === "cancel") return "cancelled";
        break;
    }

    throw new InvalidToolTransitionError(current, event.type);
  })();

  return next;
}

export class InvalidToolTransitionError extends Error {
  constructor(readonly from: ToolState, readonly event: ToolStateEvent["type"]) {
    super(`invalid_tool_transition:${from}:${event}`);
    this.name = "InvalidToolTransitionError";
  }
}
