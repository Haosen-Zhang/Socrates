import { describe, expect, it } from "bun:test";
import {
  reduceRunState,
  reduceAgentState,
  reduceTurnState,
  reduceToolState,
  isTerminalRunState,
  isTerminalAgentState,
  isTerminalTurnState,
  isTerminalToolState,
  InvalidRunTransitionError,
  InvalidAgentTransitionError,
  InvalidTurnTransitionError,
  InvalidToolTransitionError,
} from "./index";

// ─── Run State ───────────────────────────────────────────────

describe("RunState", () => {
  it("created → running via start", () => {
    expect(reduceRunState("created", { type: "start" })).toBe("running");
  });

  it("created → cancelling via cancel", () => {
    expect(reduceRunState("created", { type: "cancel" })).toBe("cancelling");
  });

  it("created → terminal disallowed", () => {
    expect(() => reduceRunState("created", { type: "complete" })).toThrow(InvalidRunTransitionError);
  });

  it("running → paused lifecycle", () => {
    expect(reduceRunState("running", { type: "pause" })).toBe("pausing");
    expect(reduceRunState("pausing", { type: "pause" })).toBe("paused");
  });

  it("running → completed", () => {
    expect(reduceRunState("running", { type: "complete" })).toBe("completed");
  });

  it("running → failed", () => {
    expect(reduceRunState("running", { type: "fail", reason: "test" })).toBe("failed");
  });

  it("running → cancelling → cancelled", () => {
    expect(reduceRunState("running", { type: "cancel" })).toBe("cancelling");
    expect(reduceRunState("cancelling", { type: "cancel" })).toBe("cancelled");
  });

  it("paused → running via resume", () => {
    expect(reduceRunState("paused", { type: "resume" })).toBe("running");
  });

  it("paused → cancelling via cancel", () => {
    expect(reduceRunState("paused", { type: "cancel" })).toBe("cancelling");
  });

  it("terminal states reject all transitions", () => {
    for (const state of ["completed", "failed", "cancelled"] as const) {
      expect(isTerminalRunState(state)).toBe(true);
      expect(() => reduceRunState(state, { type: "start" })).toThrow(InvalidRunTransitionError);
      expect(() => reduceRunState(state, { type: "complete" })).toThrow(InvalidRunTransitionError);
    }
  });

  it("non-terminal states are not terminal", () => {
    for (const state of ["created", "running", "pausing", "paused", "cancelling"] as const) {
      expect(isTerminalRunState(state)).toBe(false);
    }
  });
});

// ─── Agent State ─────────────────────────────────────────────

describe("AgentState", () => {
  it("ready → running via run_started", () => {
    expect(reduceAgentState("ready", { type: "run_started" })).toBe("running");
  });

  it("ready → stopped via close", () => {
    expect(reduceAgentState("ready", { type: "close" })).toBe("stopped");
  });

  it("ready stays ready on initialize", () => {
    expect(reduceAgentState("ready", { type: "initialize" })).toBe("ready");
  });

  it("running → waiting via awaiting_approval", () => {
    expect(reduceAgentState("running", { type: "awaiting_approval" })).toBe("waiting");
  });

  it("running → waiting via awaiting_user", () => {
    expect(reduceAgentState("running", { type: "awaiting_user" })).toBe("waiting");
  });

  it("running → interrupted via interrupt", () => {
    expect(reduceAgentState("running", { type: "interrupt" })).toBe("interrupted");
  });

  it("waiting → running via approval_resolved", () => {
    expect(reduceAgentState("waiting", { type: "approval_resolved" })).toBe("running");
  });

  it("waiting → running via user_input_received", () => {
    expect(reduceAgentState("waiting", { type: "user_input_received" })).toBe("running");
  });

  it("interrupted → running via turn_started", () => {
    expect(reduceAgentState("interrupted", { type: "turn_started" })).toBe("running");
  });

  it("running → completed via complete", () => {
    expect(reduceAgentState("running", { type: "complete" })).toBe("completed");
  });

  it("running → failed via fail", () => {
    expect(reduceAgentState("running", { type: "fail", reason: "test" })).toBe("failed");
  });

  it("completed → stopped via close", () => {
    expect(reduceAgentState("completed", { type: "close" })).toBe("stopped");
  });

  it("terminal states reject non-close events", () => {
    for (const state of ["completed", "failed", "stopped"] as const) {
      expect(isTerminalAgentState(state)).toBe(true);
      // Only "close" should work on completed/failed
      if (state !== "stopped") {
        expect(() => reduceAgentState(state, { type: "run_started" })).toThrow(InvalidAgentTransitionError);
      }
    }
  });
});

// ─── Turn State ──────────────────────────────────────────────

describe("TurnState", () => {
  it("queued → preparing → sampling", () => {
    expect(reduceTurnState("queued", { type: "prepare" })).toBe("preparing");
    expect(reduceTurnState("preparing", { type: "sample" })).toBe("sampling");
  });

  it("queued → cancelled", () => {
    expect(reduceTurnState("queued", { type: "cancel" })).toBe("cancelled");
  });

  it("sampling → processing_response (text-only → finalizing → completed)", () => {
    const afterSample = reduceTurnState("sampling", { type: "model_response", hasToolCalls: false, needsApproval: false });
    expect(afterSample).toBe("processing_response");
    const afterFinalize = reduceTurnState("processing_response", { type: "model_response", hasToolCalls: false, needsApproval: false });
    expect(afterFinalize).toBe("finalizing");
    expect(reduceTurnState("finalizing", { type: "complete" })).toBe("completed");
  });

  it("sampling → processing_response (with tools, needs approval)", () => {
    const afterSample = reduceTurnState("sampling", { type: "model_response", hasToolCalls: true, needsApproval: true });
    expect(afterSample).toBe("processing_response");
    expect(reduceTurnState("processing_response", { type: "model_response", hasToolCalls: true, needsApproval: true }))
      .toBe("awaiting_tool_approval");
  });

  it("sampling → processing_response (with tools, no approval)", () => {
    const afterSample = reduceTurnState("sampling", { type: "model_response", hasToolCalls: true, needsApproval: false });
    expect(afterSample).toBe("processing_response");
    expect(reduceTurnState("processing_response", { type: "model_response", hasToolCalls: true, needsApproval: false }))
      .toBe("executing_tools");
  });

  it("awaiting_tool_approval → executing_tools → sampling loop", () => {
    expect(reduceTurnState("awaiting_tool_approval", { type: "approval_settled" })).toBe("executing_tools");
    expect(reduceTurnState("executing_tools", { type: "tools_completed" })).toBe("sampling");
  });

  it("cancel from any non-terminal state", () => {
    for (const state of ["queued", "preparing", "sampling", "processing_response", "awaiting_tool_approval", "executing_tools"] as const) {
      expect(reduceTurnState(state, { type: "cancel" })).toBe("cancelled");
    }
  });

  it("terminal states reject all transitions", () => {
    for (const state of ["completed", "failed", "cancelled"] as const) {
      expect(isTerminalTurnState(state)).toBe(true);
      expect(() => reduceTurnState(state, { type: "prepare" })).toThrow(InvalidTurnTransitionError);
      expect(() => reduceTurnState(state, { type: "sample" })).toThrow(InvalidTurnTransitionError);
    }
  });

  it("processing_response → awaiting_user", () => {
    expect(reduceTurnState("processing_response", { type: "user_input_required" })).toBe("awaiting_user");
  });

  it("awaiting_user → sampling via user_input_received", () => {
    expect(reduceTurnState("awaiting_user", { type: "user_input_received" })).toBe("sampling");
  });
});

// ─── Tool State ──────────────────────────────────────────────

describe("ToolState", () => {
  it("proposed → awaiting_approval", () => {
    expect(reduceToolState("proposed", { type: "request_approval" })).toBe("awaiting_approval");
  });

  it("proposed → approved (no approval needed)", () => {
    expect(reduceToolState("proposed", { type: "allow", approved: true, allow_session: false })).toBe("approved");
  });

  it("proposed → running (execute without approval)", () => {
    expect(reduceToolState("proposed", { type: "execute" })).toBe("running");
  });

  it("proposed → cancelled", () => {
    expect(reduceToolState("proposed", { type: "cancel" })).toBe("cancelled");
  });

  it("awaiting_approval → approved via allow", () => {
    expect(reduceToolState("awaiting_approval", { type: "allow", approved: true, allow_session: false })).toBe("approved");
  });

  it("awaiting_approval → rejected via deny", () => {
    expect(reduceToolState("awaiting_approval", { type: "deny" })).toBe("rejected");
  });

  it("approved → running → succeeded", () => {
    expect(reduceToolState("approved", { type: "execute" })).toBe("running");
    expect(reduceToolState("running", { type: "complete", success: true })).toBe("succeeded");
  });

  it("running → failed", () => {
    expect(reduceToolState("running", { type: "complete", success: false, error: "oops" })).toBe("failed");
  });

  it("running → timed_out", () => {
    expect(reduceToolState("running", { type: "timeout" })).toBe("timed_out");
  });

  it("running → cancelled", () => {
    expect(reduceToolState("running", { type: "cancel" })).toBe("cancelled");
  });

  it("terminal states reject all transitions", () => {
    for (const state of ["rejected", "succeeded", "failed", "cancelled", "timed_out"] as const) {
      expect(isTerminalToolState(state)).toBe(true);
      expect(() => reduceToolState(state, { type: "execute" })).toThrow(InvalidToolTransitionError);
      expect(() => reduceToolState(state, { type: "complete", success: true })).toThrow(InvalidToolTransitionError);
    }
  });
});
