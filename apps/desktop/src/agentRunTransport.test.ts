import { describe, expect, it } from "bun:test";
import type { ExecutionEvent } from "@socrates/core";
import {
  captureActiveAgentRun,
  RetryableAgentRunProjectionError,
  stopAgentObservers,
  agentRunStateAfterObservation,
  observeDurableRun,
  pollAgentRunUntilTerminal,
} from "./agentRunTransport";

function executionEvent(seq: number, type: "run.created" | "run.completed"): ExecutionEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${seq}`,
    sessionId: "session-1",
    runId: "run-1",
    agentId: "agent-1",
    seq,
    type,
    coordinates: {},
    payload: type === "run.created" ? { threadId: "thread-1", attemptNo: 1 } : {},
    occurredAt: "now",
  } as ExecutionEvent;
}

describe("agent Run observer recovery", () => {
  it("detaches observers before a Session view projection is reset", async () => {
    let finish!: (value: boolean) => void;
    const controller = new AbortController();
    const promise = new Promise<boolean>((resolve) => { finish = resolve; });
    controller.signal.addEventListener("abort", () => finish(false), { once: true });
    const observers = new Map([["run-1", {
      sessionId: "session-1", controller, promise,
    }]]);

    await stopAgentObservers(observers);

    expect(controller.signal.aborted).toBe(true);
    expect(observers.size).toBe(0);
  });
  it("captures Run ownership before storage-degraded Session switching", async () => {
    let finish!: (value: boolean) => void;
    const controller = new AbortController();
    const promise = new Promise<boolean>((resolve) => { finish = resolve; });
    controller.signal.addEventListener("abort", () => finish(false), { once: true });
    const observers = new Map([["run-1", {
      sessionId: "session-a", controller, promise,
    }]]);
    const fallback = captureActiveAgentRun("run-1", observers);
    await stopAgentObservers(observers);

    expect(fallback).toEqual({ sessionId: "session-a", runId: "run-1" });
    const terminal = await pollAgentRunUntilTerminal(
      async () => ({ status: "completed", error: null }),
      () => true,
      async () => {},
    );
    expect(agentRunStateAfterObservation(fallback!.runId, terminal, null).agentRunning).toBe(false);
  });
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

  it("does not show a disconnect error while a durable active Run is resuming", () => {
    expect(agentRunStateAfterObservation(
      "run-1", { status: "running", error: null }, null,
    ).agentError).toBeNull();
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

  it("releases the global handle after a background Run completes in another Session", async () => {
    const terminal = await pollAgentRunUntilTerminal(
      async () => ({ status: "completed", error: null }),
      () => true,
      async () => {},
    );
    expect(agentRunStateAfterObservation("run-in-session-a", terminal, null)).toEqual({
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

  it("reconnects from the last durable sequence without duplicating events", async () => {
    const openedAfter: number[] = [];
    const received: number[] = [];
    let attempt = 0;
    const result = await observeDurableRun({
      runId: "run-1",
      afterSeq: 0,
      open: (afterSeq) => {
        openedAfter.push(afterSeq);
        attempt += 1;
        return (async function* () {
          if (attempt === 1) {
            yield executionEvent(1, "run.created");
            throw new Error("observer_disconnected");
          }
          yield executionEvent(1, "run.created");
          yield executionEvent(2, "run.completed");
        })();
      },
      shouldContinue: () => true,
      onEvent: async (event) => { received.push(event.seq); },
      wait: async () => {},
    });
    expect(openedAfter).toEqual([0, 1]);
    expect(received).toEqual([1, 2]);
    expect(result).toEqual({ lastSeq: 2, terminal: true });
  });

  it("requests replay from the current cursor when a live stream has a gap", async () => {
    const openedAfter: number[] = [];
    let attempt = 0;
    const result = await observeDurableRun({
      runId: "run-1",
      afterSeq: 0,
      open: (afterSeq) => {
        openedAfter.push(afterSeq);
        attempt += 1;
        return (async function* () {
          if (attempt === 1) yield executionEvent(2, "run.completed");
          else {
            yield executionEvent(1, "run.created");
            yield executionEvent(2, "run.completed");
          }
        })();
      },
      shouldContinue: () => true,
      onEvent: async () => {},
      wait: async () => {},
    });
    expect(openedAfter).toEqual([0, 0]);
    expect(result.lastSeq).toBe(2);
  });

  it("replays an approval event when its dependent projection fails transiently", async () => {
    const approval = {
      ...executionEvent(2, "run.completed"),
      eventId: "approval-2",
      type: "approval.requested",
      payload: { requestId: "approval-1", subjectId: "subject-1", callId: "call-1" },
    } as ExecutionEvent;
    const openedAfter: number[] = [];
    const waits: number[] = [];
    let projections = 0;
    const result = await observeDurableRun({
      runId: "run-1",
      afterSeq: 1,
      open: (afterSeq) => {
        openedAfter.push(afterSeq);
        return (async function* () {
          yield approval;
          if (projections > 0) yield executionEvent(3, "run.completed");
        })();
      },
      shouldContinue: () => true,
      onEvent: async (event) => {
        if (event.type === "approval.requested" && projections++ === 0) {
          throw new RetryableAgentRunProjectionError("approval_fetch_failed");
        }
      },
      wait: async (milliseconds) => { waits.push(milliseconds); },
    });
    expect(openedAfter).toEqual([1, 1]);
    expect(projections).toBe(2);
    expect(waits).toEqual([250]);
    expect(result).toEqual({ lastSeq: 3, terminal: true });
  });
});
