export type TaskState =
  | "idle" | "preparing" | "discussing" | "synthesizing" | "awaiting_plan_approval"
  | "revising_plan" | "executing" | "awaiting_tool_approval" | "paused"
  | "failed" | "cancelled" | "completed";

export type ResumableTaskState = "preparing" | "discussing" | "synthesizing" | "executing" | "awaiting_tool_approval";

export type TaskStateEvent =
  | { type: "submit" }
  | { type: "prepared_multi" }
  | { type: "next_turn" }
  | { type: "discussion_complete" }
  | { type: "plan_ready" }
  | { type: "approve_plan" }
  | { type: "edit_plan" | "request_replan" }
  | { type: "reopen_discussion" | "synthesize_revision" | "edited_plan_ready" }
  | { type: "tool_approval_required" }
  | { type: "tool_approval_settled" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "fail" | "cancel" | "complete"; reason?: string };

export interface TaskStateSnapshot {
  state: TaskState;
  resumeFrom: ResumableTaskState | null;
  terminalReason: string | null;
}

export class InvalidTaskTransitionError extends Error {
  constructor(readonly from: TaskState, readonly event: TaskStateEvent["type"]) {
    super(`invalid_task_transition:${from}:${event}`);
  }
}

const terminal = new Set<TaskState>(["failed", "cancelled", "completed"]);
const resumable = new Set<ResumableTaskState>(["preparing", "discussing", "synthesizing", "executing", "awaiting_tool_approval"]);

export function reduceTaskState(current: TaskStateSnapshot, event: TaskStateEvent): TaskStateSnapshot {
  if (terminal.has(current.state)) throw new InvalidTaskTransitionError(current.state, event.type);
  if (event.type === "fail" || event.type === "cancel" || event.type === "complete") {
    if (event.type === "complete" && current.state !== "executing") throw new InvalidTaskTransitionError(current.state, event.type);
    return { state: event.type === "fail" ? "failed" : event.type === "cancel" ? "cancelled" : "completed", resumeFrom: null, terminalReason: event.reason ?? null };
  }
  if (event.type === "pause" && resumable.has(current.state as ResumableTaskState)) {
    return { ...current, state: "paused", resumeFrom: current.state as ResumableTaskState };
  }
  if (event.type === "resume" && current.state === "paused" && current.resumeFrom) {
    return { ...current, state: current.resumeFrom, resumeFrom: null };
  }
  const key = `${current.state}:${event.type}`;
  const next: Record<string, TaskState> = {
    "idle:submit": "preparing", "preparing:prepared_multi": "discussing",
    "discussing:next_turn": "discussing", "discussing:discussion_complete": "synthesizing",
    "synthesizing:plan_ready": "awaiting_plan_approval",
    "awaiting_plan_approval:approve_plan": "executing",
    "awaiting_plan_approval:edit_plan": "revising_plan", "awaiting_plan_approval:request_replan": "revising_plan",
    "revising_plan:reopen_discussion": "discussing", "revising_plan:synthesize_revision": "synthesizing",
    "revising_plan:edited_plan_ready": "awaiting_plan_approval",
    "executing:tool_approval_required": "awaiting_tool_approval",
    "awaiting_tool_approval:tool_approval_settled": "executing",
  };
  const state = next[key];
  if (!state) throw new InvalidTaskTransitionError(current.state, event.type);
  return { state, resumeFrom: null, terminalReason: null };
}
