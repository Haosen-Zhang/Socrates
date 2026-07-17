import { describe, expect, it } from "bun:test";
import { isTerminalRuntimeStatus, runtimeTransitionAllowed } from "./runtime";

describe("agent runtime lifecycle", () => {
  it("allows explicit forward and interruption transitions", () => {
    expect(runtimeTransitionAllowed("opening", "ready")).toBe(true);
    expect(runtimeTransitionAllowed("running", "awaiting_approval")).toBe(true);
    expect(runtimeTransitionAllowed("awaiting_approval", "running")).toBe(true);
    expect(runtimeTransitionAllowed("running", "interrupted")).toBe(true);
    expect(runtimeTransitionAllowed("completed", "running")).toBe(false);
  });

  it("recognizes terminal states", () => {
    expect(isTerminalRuntimeStatus("completed")).toBe(true);
    expect(isTerminalRuntimeStatus("failed")).toBe(true);
    expect(isTerminalRuntimeStatus("running")).toBe(false);
  });
});
