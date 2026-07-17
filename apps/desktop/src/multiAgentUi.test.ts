import { describe, expect, it } from "bun:test";
import { canReviewPlan, dropAgentBefore, moveAgentId } from "./multiAgentUi";

describe("multi-agent setup and plan UI", () => {
  it("reorders a 20-agent roster by keyboard or drag without dropping members", () => {
    const ids = Array.from({ length: 20 }, (_, index) => `agent-${index}`);
    expect(moveAgentId(ids, "agent-10", -1)[9]).toBe("agent-10");
    const dropped = dropAgentBefore(ids, "agent-19", "agent-0");
    expect(dropped[0]).toBe("agent-19");
    expect(new Set(dropped).size).toBe(20);
  });
  it("shows approval actions only for the pending exact plan", () => {
    expect(canReviewPlan("awaiting_plan_approval", "pending")).toBe(true);
    expect(canReviewPlan("executing", "approved")).toBe(false);
  });
});
