/**
 * Turn 状态机 — Socrates Phase 1
 *
 * Turn 是 Agent 从接收 prompt 到产生完整回答的一个完整对话轮次。
 * 一次 Turn 可以包含多次模型采样（当有 Tool Call 时，模型采样→工具执行→再采样）。
 */

export type TurnState =
  | "queued"
  | "preparing"
  | "sampling"
  | "processing_response"
  | "awaiting_tool_approval"
  | "executing_tools"
  | "awaiting_user"
  | "compacting"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";

export type TurnStateEvent =
  | { type: "prepare" }
  | { type: "sample" }
  | { type: "model_response"; hasToolCalls: boolean; needsApproval: boolean }
  | { type: "approval_requested" }
  | { type: "approval_settled" }
  | { type: "tools_completed" }
  | { type: "user_input_required" }
  | { type: "user_input_received" }
  | { type: "context_full" }
  | { type: "compacted" }
  | { type: "finalize" }
  | { type: "complete" }
  | { type: "fail"; reason: string }
  | { type: "cancel" };

export const TURN_TERMINAL_STATES = new Set<TurnState>(["completed", "failed", "cancelled"]);

export function isTerminalTurnState(state: TurnState): boolean {
  return TURN_TERMINAL_STATES.has(state);
}

export function reduceTurnState(current: TurnState, event: TurnStateEvent): TurnState {
  if (isTerminalTurnState(current)) {
    throw new InvalidTurnTransitionError(current, event.type);
  }

  const next = ((): TurnState => {
    switch (current) {
      case "queued":
        if (event.type === "prepare") return "preparing";
        if (event.type === "cancel") return "cancelled";
        break;

      case "preparing":
        if (event.type === "sample") return "sampling";
        if (event.type === "fail") return "failed";
        if (event.type === "cancel") return "cancelled";
        break;

      case "sampling":
        if (event.type === "model_response") return "processing_response";
        if (event.type === "fail") return "failed";
        if (event.type === "cancel") return "cancelled";
        break;

      case "processing_response":
        if (event.type === "model_response" && !event.hasToolCalls) return "finalizing";
        if (event.type === "model_response" && event.hasToolCalls && event.needsApproval) return "awaiting_tool_approval";
        if (event.type === "model_response" && event.hasToolCalls && !event.needsApproval) return "executing_tools";
        if (event.type === "user_input_required") return "awaiting_user";
        if (event.type === "context_full") return "compacting";
        if (event.type === "complete") return "completed";
        if (event.type === "finalize") return "finalizing";
        if (event.type === "fail") return "failed";
        if (event.type === "cancel") return "cancelled";
        break;

      case "awaiting_tool_approval":
        if (event.type === "approval_settled") return "executing_tools";
        if (event.type === "cancel") return "cancelled";
        if (event.type === "fail") return "failed";
        break;

      case "executing_tools":
        if (event.type === "tools_completed") return "sampling";
        if (event.type === "fail") return "failed";
        if (event.type === "cancel") return "cancelled";
        break;

      case "awaiting_user":
        if (event.type === "user_input_received") return "sampling";
        if (event.type === "fail") return "failed";
        if (event.type === "cancel") return "cancelled";
        break;

      case "compacting":
        if (event.type === "compacted") return "sampling";
        if (event.type === "fail") return "failed";
        if (event.type === "cancel") return "cancelled";
        break;

      case "finalizing":
        if (event.type === "complete") return "completed";
        if (event.type === "fail") return "failed";
        if (event.type === "cancel") return "cancelled";
        break;
    }

    throw new InvalidTurnTransitionError(current, event.type);
  })();

  return next;
}

export class InvalidTurnTransitionError extends Error {
  constructor(readonly from: TurnState, readonly event: TurnStateEvent["type"]) {
    super(`invalid_turn_transition:${from}:${event}`);
    this.name = "InvalidTurnTransitionError";
  }
}
