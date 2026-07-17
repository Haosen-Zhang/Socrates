import { describe, expect, it } from "bun:test";
import { InvalidTaskTransitionError, reduceTaskState, type TaskStateSnapshot } from "./task-state";

const at = (state: TaskStateSnapshot["state"], resumeFrom: TaskStateSnapshot["resumeFrom"] = null): TaskStateSnapshot => ({ state, resumeFrom, terminalReason: null });

describe("TaskStateMachine", () => {
  it("covers discussion, exact plan approval, tool approval and completion", () => {
    let value = reduceTaskState(at("idle"), { type: "submit" });
    value = reduceTaskState(value, { type: "prepared_multi" });
    value = reduceTaskState(value, { type: "next_turn" });
    value = reduceTaskState(value, { type: "discussion_complete" });
    value = reduceTaskState(value, { type: "plan_ready" });
    value = reduceTaskState(value, { type: "approve_plan" });
    value = reduceTaskState(value, { type: "tool_approval_required" });
    value = reduceTaskState(value, { type: "tool_approval_settled" });
    expect(reduceTaskState(value, { type: "complete" })).toEqual({ state: "completed", resumeFrom: null, terminalReason: null });
  });

  it("pauses with an exact resume target and rejects terminal resurrection", () => {
    expect(reduceTaskState(at("paused", "discussing"), { type: "resume" }).state).toBe("discussing");
    expect(reduceTaskState(at("executing"), { type: "pause" })).toEqual({ state: "paused", resumeFrom: "executing", terminalReason: null });
    expect(reduceTaskState(at("executing"), { type: "pause", reason: "review" }).terminalReason).toBe("review");
    expect(() => reduceTaskState(at("cancelled"), { type: "submit" })).toThrow(InvalidTaskTransitionError);
    expect(() => reduceTaskState(at("awaiting_plan_approval"), { type: "complete" })).toThrow("invalid_task_transition");
  });
});
