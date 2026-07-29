/**
 * Run 状态机 — Socrates Phase 1
 *
 * Run 是一次完整的用户请求 → Agent 回答的生命周期。
 * 一个 Run 包含一个或多个 Turn（Phase 1：最多一个 Active Turn）。
 *
 * 终态：completed | failed | cancelled
 * 瞬态：cancelling（取消中，必定到达 cancelled）
 */

export type RunState =
  | "created"
  | "running"
  | "pausing"
  | "paused"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export type RunStateEvent =
  | { type: "start" }
  | { type: "pause"; reason?: string }
  | { type: "resume" }
  | { type: "cancel"; reason?: string }
  | { type: "complete" }
  | { type: "fail"; reason: string };

/** 终态集合 — 一旦进入不可再迁移 */
export const RUN_TERMINAL_STATES = new Set<RunState>(["completed", "failed", "cancelled"]);

export function isTerminalRunState(state: RunState): boolean {
  return RUN_TERMINAL_STATES.has(state);
}

/** 允许的迁移表 */
const RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  created: ["running", "cancelling"],
  running: ["pausing", "cancelling", "completed", "failed"],
  pausing: ["paused", "cancelling"],
  paused: ["running", "cancelling"],
  cancelling: ["cancelled"],
  completed: [], // 终态
  failed: [], // 终态
  cancelled: [], // 终态
};

export function allowedRunTransitions(from: RunState): readonly RunState[] {
  return RUN_TRANSITIONS[from];
}

export function reduceRunState(current: RunState, event: RunStateEvent): RunState {
  if (isTerminalRunState(current)) {
    throw new InvalidRunTransitionError(current, event.type);
  }

  const next = ((): RunState => {
    switch (current) {
      case "created":
        if (event.type === "start") return "running";
        if (event.type === "cancel") return "cancelling";
        break;

      case "running":
        if (event.type === "pause") return "pausing";
        if (event.type === "cancel") return "cancelling";
        if (event.type === "complete") return "completed";
        if (event.type === "fail") return "failed";
        break;

      case "pausing":
        if (event.type === "fail" || event.type === "pause") return "paused";
        if (event.type === "cancel") return "cancelling";
        break;

      case "paused":
        if (event.type === "resume") return "running";
        if (event.type === "cancel") return "cancelling";
        break;

      case "cancelling":
        // 取消中的唯一出口
        return "cancelled"; // 接受 cancel 以外的任何事件都视为取消完成
    }

    throw new InvalidRunTransitionError(current, event.type);
  })();

  return next;
}

export class InvalidRunTransitionError extends Error {
  constructor(readonly from: RunState, readonly event: RunStateEvent["type"]) {
    super(`invalid_run_transition:${from}:${event}`);
    this.name = "InvalidRunTransitionError";
  }
}
