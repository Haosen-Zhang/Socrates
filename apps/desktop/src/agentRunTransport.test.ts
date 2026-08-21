import { describe, expect, it } from "bun:test";
import { agentRunStateAfterObservation, pollAgentRunUntilTerminal } from "./agentRunTransport";

describe("agent Run observer recovery", () => {
  it("retains the cancellation handle when POST succeeded but event observation failed", () => {
    expect(agentRunStateAfterObservation(
      "run-1",
      { status: "running", error: null },
      "network_error",
    )).toEqual({
      agentRunning: true,
      activeAgentRunId: "run-1",
      agentError: "network_error",
    });
  });

  it("releases the handle only after durable status is terminal", () => {
    expect(agentRunStateAfterObservation(
      "run-1",
      { status: "completed", error: null },
      null,
    )).toEqual({
      agentRunning: false,
      activeAgentRunId: null,
      agentError: null,
    });
  });

  it("keeps reconciling a disconnected observer until durable completion", async () => {
    const statuses = [
      { status: "running", error: null },
      { status: "completed", error: null },
    ];
    const terminal = await pollAgentRunUntilTerminal(
      async () => statuses.shift()!,
      () => true,
      async () => {},
    );
    expect(terminal).toEqual({ status: "completed", error: null });
  });

  it("stops reconciliation after explicit cancellation releases the handle", async () => {
    let active = true;
    const terminal = await pollAgentRunUntilTerminal(
      async () => {
        active = false;
        return { status: "running", error: null };
      },
      () => active,
      async () => {},
    );
    expect(terminal).toBeNull();
  });

  it("ignores a stale terminal response after another Run takes the handle", async () => {
    let currentRunId = "old-run";
    const terminal = await pollAgentRunUntilTerminal(
      async () => {
        currentRunId = "new-run";
        return { status: "cancelled", error: null };
      },
      () => currentRunId === "old-run",
      async () => {},
    );
    expect(terminal).toBeNull();
  });
});
