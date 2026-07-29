/**
 * Agent 状态机 — Socrates Phase 1
 *
 * Agent 状态描述单个 Agent 在 Run 中的运行时状态。
 * Phase 1 只有 root agent，但状态机从第一天就绑定 agentId。
 */

export type AgentState =
  | "ready"
  | "running"
  | "waiting"
  | "interrupted"
  | "completed"
  | "failed"
  | "stopped";

export type AgentStateEvent =
  | { type: "initialize" }
  | { type: "run_started" }
  | { type: "turn_started" }
  | { type: "turn_completed" }
  | { type: "awaiting_approval" }
  | { type: "approval_resolved" }
  | { type: "awaiting_user" }
  | { type: "user_input_received" }
  | { type: "interrupt" }
  | { type: "complete" }
  | { type: "fail"; reason: string }
  | { type: "close" };

export const AGENT_TERMINAL_STATES = new Set<AgentState>(["completed", "failed", "stopped"]);

export function isTerminalAgentState(state: AgentState): boolean {
  return AGENT_TERMINAL_STATES.has(state);
}

export function reduceAgentState(current: AgentState, event: AgentStateEvent): AgentState {
  // "close" on completed/failed → stopped is the only allowed terminal transition
  if (event.type === "close" && (current === "completed" || current === "failed")) {
    return "stopped";
  }

  if (isTerminalAgentState(current)) {
    throw new InvalidAgentTransitionError(current, event.type);
  }

  const next = ((): AgentState => {
    switch (current) {
      case "ready":
        if (event.type === "initialize") return "ready";
        if (event.type === "run_started") return "running";
        if (event.type === "close") return "stopped";
        break;

      case "running":
        if (event.type === "awaiting_approval" || event.type === "awaiting_user") return "waiting";
        if (event.type === "interrupt") return "interrupted";
        if (event.type === "complete") return "completed";
        if (event.type === "fail") return "failed";
        if (event.type === "close") return "stopped";
        break;

      case "waiting":
        if (event.type === "approval_resolved" || event.type === "user_input_received" || event.type === "turn_started") return "running";
        if (event.type === "interrupt") return "interrupted";
        if (event.type === "fail") return "failed";
        if (event.type === "close") return "stopped";
        break;

      case "interrupted":
        if (event.type === "turn_started") return "running";
        if (event.type === "fail") return "failed";
        if (event.type === "close") return "stopped";
        break;

      case "completed":
      case "failed":
        if (event.type === "close") return "stopped";
        break;
    }

    throw new InvalidAgentTransitionError(current, event.type);
  })();

  return next;
}

export class InvalidAgentTransitionError extends Error {
  constructor(readonly from: AgentState, readonly event: AgentStateEvent["type"]) {
    super(`invalid_agent_transition:${from}:${event}`);
    this.name = "InvalidAgentTransitionError";
  }
}
