import { describe, expect, it } from "bun:test";
import {
  executionEventProjectsTo,
  executionEventToRuntimeEvent,
  initialExecutionProjection,
  reduceExecutionProjection,
  validateExecutionCoordinates,
  type ExecutionEvent,
} from "./execution-events";

const event = (
  seq: number,
  type: ExecutionEvent["type"],
  coordinates: ExecutionEvent["coordinates"] = {},
): ExecutionEvent => ({
  schemaVersion: 1,
  eventId: `event-${seq}`,
  sessionId: "session-1",
  runId: "run-1",
  agentId: "agent-1",
  seq,
  type,
  coordinates,
  payload: {},
  occurredAt: `2026-08-21T00:00:0${seq}.000Z`,
});

describe("execution event contracts", () => {
  it("tracks explicit Run, Turn, Step, and Attempt identities through a pure projection", () => {
    let state = initialExecutionProjection("run-1");
    const events = [
      event(1, "run.created"),
      event(2, "run.started"),
      event(3, "turn.started", { turnId: "turn-1" }),
      event(4, "step.started", { turnId: "turn-1", stepId: "step-1" }),
      event(5, "provider.attempt.started", {
        turnId: "turn-1",
        stepId: "step-1",
        providerAttemptId: "provider-attempt-1",
      }),
      event(6, "tool.operation.requested", {
        turnId: "turn-1",
        stepId: "step-1",
        toolOperationId: "tool-operation-1",
      }),
      event(7, "tool.attempt.started", {
        turnId: "turn-1",
        stepId: "step-1",
        toolOperationId: "tool-operation-1",
        toolAttemptId: "tool-attempt-1",
      }),
    ];

    for (const item of events) {
      const reduced = reduceExecutionProjection(state, item);
      expect(reduced.kind).toBe("applied");
      if (reduced.kind === "applied") state = reduced.state;
    }

    expect(state).toMatchObject({
      runId: "run-1",
      runStatus: "running",
      lastSeq: 7,
      turnId: "turn-1",
      stepId: "step-1",
      providerAttemptId: "provider-attempt-1",
      toolOperationId: "tool-operation-1",
      toolAttemptId: "tool-attempt-1",
    });
  });

  it("rejects identity hierarchy gaps before they can be persisted", () => {
    expect(validateExecutionCoordinates("step.started", { stepId: "step-1" }))
      .toEqual(["execution_step_requires_turn"]);
    expect(validateExecutionCoordinates("provider.attempt.started", { providerAttemptId: "provider-attempt-1" }))
      .toEqual(["execution_provider_attempt_requires_step"]);
    expect(validateExecutionCoordinates("tool.attempt.started", { turnId: "turn-1", stepId: "step-1", toolAttemptId: "attempt-1" }))
      .toEqual(["execution_tool_attempt_requires_operation"]);
    expect(validateExecutionCoordinates("turn.started", {}))
      .toEqual(["execution_turn_identity_required"]);
    expect(validateExecutionCoordinates("step.started", { turnId: "turn-1" }))
      .toEqual(["execution_step_identity_required"]);
    expect(validateExecutionCoordinates("provider.attempt.started", {
      turnId: "turn-1", stepId: "step-1",
    })).toEqual(["execution_provider_attempt_identity_required"]);
    expect(validateExecutionCoordinates("tool.operation.requested", {
      turnId: "turn-1", stepId: "step-1",
    })).toEqual(["execution_tool_operation_identity_required"]);
  });

  it("clears child identities when a new parent scope starts", () => {
    let state = initialExecutionProjection("run-1");
    for (const item of [
      event(1, "turn.started", { turnId: "turn-1" }),
      event(2, "step.started", { turnId: "turn-1", stepId: "step-1" }),
      event(3, "tool.attempt.started", {
        turnId: "turn-1",
        stepId: "step-1",
        toolOperationId: "operation-1",
        toolAttemptId: "attempt-1",
      }),
      event(4, "turn.started", { turnId: "turn-2" }),
    ]) {
      const reduced = reduceExecutionProjection(state, item);
      if (reduced.kind !== "applied") throw new Error("expected applied event");
      state = reduced.state;
    }
    expect(state).toEqual({
      runId: "run-1",
      runStatus: "unknown",
      lastSeq: 4,
      turnId: "turn-2",
    });
  });

  it("detects duplicates and gaps without guessing projection state", () => {
    const initial = initialExecutionProjection("run-1");
    const first = reduceExecutionProjection(initial, event(1, "run.created"));
    expect(first.kind).toBe("applied");
    if (first.kind !== "applied") throw new Error("expected applied event");
    expect(reduceExecutionProjection(first.state, event(1, "run.created")).kind).toBe("duplicate");
    expect(reduceExecutionProjection(first.state, event(3, "run.started"))).toEqual({
      kind: "gap",
      expectedSeq: 2,
      receivedSeq: 3,
    });
  });

  it("keeps durable execution events out of model history", () => {
    const runtimeEvent = event(1, "runtime.event");
    expect(executionEventProjectsTo(runtimeEvent, "runtime")).toBe(true);
    expect(executionEventProjectsTo(runtimeEvent, "ui")).toBe(true);
    expect(executionEventProjectsTo(runtimeEvent, "audit")).toBe(true);
    expect(executionEventProjectsTo(runtimeEvent, "model_history")).toBe(false);
  });

  it("projects durable execution facts into the existing Runtime UI contract", () => {
    expect(executionEventToRuntimeEvent({
      ...event(1, "provider.attempt.started", {
        turnId: "turn-1", stepId: "step-1", providerAttemptId: "attempt-1",
      }),
      payload: { attemptNo: 1 },
    })).toEqual({
      type: "extension",
      name: "provider_attempt_started",
      payload: { attemptNo: 1 },
    });
    expect(executionEventToRuntimeEvent({
      ...event(1, "runtime.event"),
      payload: {
        runtimeSessionId: "runtime-1",
        event: { type: "text_delta", text: "hello" },
      },
    })).toEqual({ type: "text_delta", text: "hello" });
    expect(executionEventToRuntimeEvent({
      ...event(2, "runtime.event"),
      payload: {
        runtimeSessionId: "runtime-1",
        event: { type: "status", status: "completed" },
      },
    })).toBeNull();
    expect(executionEventToRuntimeEvent({
      ...event(3, "runtime.event"),
      payload: {
        runtimeSessionId: "runtime-1",
        event: { type: "approval_required", requestId: "runtime-request", callId: "call-1" },
      },
    })).toBeNull();
    expect(executionEventToRuntimeEvent({
      ...event(4, "approval.requested"),
      payload: {
        requestId: "durable-request",
        subjectId: "subject-1",
        callId: "call-1",
        risk: "high",
      },
    })).toEqual({
      type: "approval_required",
      requestId: "durable-request",
      callId: "call-1",
      risk: "high",
      kind: undefined,
      policyVersion: undefined,
      freshHumanRequired: undefined,
    });
    expect(executionEventToRuntimeEvent({
      ...event(5, "run.failed"),
      payload: { error: "provider_failed" },
    })).toEqual({ type: "status", status: "failed", message: "provider_failed" });
  });
});
