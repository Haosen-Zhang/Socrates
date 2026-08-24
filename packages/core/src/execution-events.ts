import type { RuntimeEvent } from "./runtime";
import type { ToolRisk } from "./tools";

export const EXECUTION_EVENT_SCHEMA_VERSION = 1 as const;

export const EXECUTION_EVENT_TYPES = [
  "run.created", "run.started", "run.cancel_requested", "run.completed",
  "run.failed", "run.cancelled", "run.interrupted", "turn.started",
  "turn.completed", "turn.failed", "turn.cancelled", "step.started",
  "step.completed", "step.failed", "provider.attempt.started",
  "provider.attempt.failed", "provider.retry_scheduled",
  "provider.attempt.completed", "tool.operation.requested",
  "tool.attempt.checkpointed", "tool.attempt.started", "tool.attempt.result",
  "tool.outcome_unknown", "runtime.event", "context.truncated",
  "approval.requested", "approval.decided",
] as const;

export type ExecutionEventType = typeof EXECUTION_EVENT_TYPES[number];

const executionEventTypes = new Set<string>(EXECUTION_EVENT_TYPES);

export function isExecutionEventType(value: string): value is ExecutionEventType {
  return executionEventTypes.has(value);
}

export interface ExecutionCoordinates {
  turnId?: string;
  stepId?: string;
  providerAttemptId?: string;
  toolOperationId?: string;
  toolAttemptId?: string;
}

type TurnCoordinates = ExecutionCoordinates & { turnId: string };
type StepCoordinates = TurnCoordinates & { stepId: string };
type ProviderAttemptCoordinates = StepCoordinates & { providerAttemptId: string };
type ToolOperationCoordinates = StepCoordinates & { toolOperationId: string };
type ToolAttemptCoordinates = ToolOperationCoordinates & { toolAttemptId: string };

export type ExecutionCoordinatesFor<T extends ExecutionEventType> =
  T extends `turn.${string}` ? TurnCoordinates
    : T extends `step.${string}` ? StepCoordinates
      : T extends `provider.${string}` ? ProviderAttemptCoordinates
        : T extends "tool.operation.requested" ? ToolOperationCoordinates
          : T extends `tool.attempt.${string}` | "tool.outcome_unknown" ? ToolAttemptCoordinates
            : ExecutionCoordinates;

export interface ExecutionEventPayloadMap {
  "run.created": { threadId: string; attemptNo: number };
  "run.started": Record<string, never>;
  "run.cancel_requested": { reason?: string };
  "run.completed": Record<string, never>;
  "run.failed": { error: string };
  "run.cancelled": { reason?: string };
  "run.interrupted": { reason: string };
  "turn.started": Record<string, never>;
  "turn.completed": Record<string, never>;
  "turn.failed": { error: string };
  "turn.cancelled": { reason?: string };
  "step.started": Record<string, never>;
  "step.completed": Record<string, never>;
  "step.failed": { error: string };
  "provider.attempt.started": { attemptNo: number };
  "provider.attempt.failed": { error: string; retryable: boolean };
  "provider.retry_scheduled": { nextAttemptNo: number; delayMs: number };
  "provider.attempt.completed": Record<string, never>;
  "tool.operation.requested": { name?: string; inputHash?: string };
  "tool.attempt.checkpointed": Record<string, never>;
  "tool.attempt.started": Record<string, never>;
  "tool.attempt.result": { status?: string; isError?: boolean };
  "tool.outcome_unknown": { disposition?: string };
  "runtime.event": { runtimeSessionId: string; event: RuntimeEvent };
  "context.truncated": {
    threadId: string;
    estimatedTokens: number;
    budgetTokens: number | null;
    runtimeOverheadTokens: number;
    droppedThroughSequence: number | null;
    overflow: boolean;
  };
  "approval.requested": {
    requestId: string;
    subjectId: string;
    callId?: string;
    risk?: ToolRisk;
    kind?: string;
    policyVersion?: number;
    freshHumanRequired?: boolean;
  };
  "approval.decided": { requestId: string; decision: string };
}

export interface ExecutionEvent<T extends ExecutionEventType = ExecutionEventType> {
  schemaVersion: typeof EXECUTION_EVENT_SCHEMA_VERSION;
  eventId: string;
  sessionId: string;
  runId: string;
  agentId: string;
  seq: number;
  type: T;
  coordinates: ExecutionCoordinatesFor<T>;
  payload: ExecutionEventPayloadMap[T];
  occurredAt: string;
}

export type ExecutionEventInput<T extends ExecutionEventType = ExecutionEventType> =
  Omit<ExecutionEvent<T>, "schemaVersion" | "seq" | "occurredAt"> & { occurredAt?: string };

export type ExecutionProjectionSurface = "runtime" | "ui" | "model_history" | "audit";

export type ExecutionRunStatus =
  | "unknown"
  | "created"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface ExecutionProjection {
  runId: string;
  runStatus: ExecutionRunStatus;
  lastSeq: number;
  turnId?: string;
  stepId?: string;
  providerAttemptId?: string;
  toolOperationId?: string;
  toolAttemptId?: string;
}

export type ExecutionProjectionResult =
  | { kind: "applied"; state: ExecutionProjection }
  | { kind: "duplicate"; state: ExecutionProjection }
  | { kind: "gap"; expectedSeq: number; receivedSeq: number };

export function initialExecutionProjection(runId: string): ExecutionProjection {
  return { runId, runStatus: "unknown", lastSeq: 0 };
}

export function validateExecutionCoordinates(
  type: ExecutionEventType,
  coordinates: ExecutionCoordinates,
): string[] {
  const values = Object.entries(coordinates);
  if (values.some(([, value]) => typeof value !== "string" || !value)) {
    return ["execution_identity_invalid"];
  }
  if (coordinates.providerAttemptId && !coordinates.stepId) {
    return ["execution_provider_attempt_requires_step"];
  }
  if (coordinates.toolAttemptId && !coordinates.toolOperationId) {
    return ["execution_tool_attempt_requires_operation"];
  }
  if (coordinates.toolOperationId && !coordinates.stepId) {
    return ["execution_tool_operation_requires_step"];
  }
  if (coordinates.stepId && !coordinates.turnId) {
    return ["execution_step_requires_turn"];
  }
  if (type.startsWith("turn.") && !coordinates.turnId) {
    return ["execution_turn_identity_required"];
  }
  if (type.startsWith("step.") && !coordinates.stepId) {
    return ["execution_step_identity_required"];
  }
  if (type.startsWith("provider.") && !coordinates.providerAttemptId) {
    return ["execution_provider_attempt_identity_required"];
  }
  if (type === "tool.operation.requested" && !coordinates.toolOperationId) {
    return ["execution_tool_operation_identity_required"];
  }
  if ((type.startsWith("tool.attempt.") || type === "tool.outcome_unknown")
    && !coordinates.toolAttemptId) {
    return ["execution_tool_attempt_identity_required"];
  }
  return [];
}

export function reduceExecutionProjection(
  state: ExecutionProjection,
  event: ExecutionEvent,
): ExecutionProjectionResult {
  if (event.runId !== state.runId) throw new Error("execution_projection_run_mismatch");
  if (event.seq <= state.lastSeq) return { kind: "duplicate", state };
  if (event.seq !== state.lastSeq + 1) {
    return { kind: "gap", expectedSeq: state.lastSeq + 1, receivedSeq: event.seq };
  }
  const errors = validateExecutionCoordinates(event.type, event.coordinates);
  if (errors[0]) throw new Error(errors[0]);

  let runStatus = state.runStatus;
  if (event.type === "run.created") runStatus = "created";
  else if (event.type === "run.started") runStatus = "running";
  else if (event.type === "run.cancel_requested") runStatus = "cancelling";
  else if (event.type === "run.completed") runStatus = "completed";
  else if (event.type === "run.failed") runStatus = "failed";
  else if (event.type === "run.cancelled") runStatus = "cancelled";
  else if (event.type === "run.interrupted") runStatus = "interrupted";

  const next: ExecutionProjection = { ...state, runStatus, lastSeq: event.seq };
  if (event.type.startsWith("turn.") || (
    event.coordinates.turnId && event.coordinates.turnId !== state.turnId
  )) {
    delete next.stepId;
    delete next.providerAttemptId;
    delete next.toolOperationId;
    delete next.toolAttemptId;
  }
  if (event.coordinates.stepId && event.coordinates.stepId !== state.stepId) {
    delete next.providerAttemptId;
    delete next.toolOperationId;
    delete next.toolAttemptId;
  }
  if (
    event.coordinates.providerAttemptId
    && event.coordinates.providerAttemptId !== state.providerAttemptId
  ) {
    delete next.toolOperationId;
    delete next.toolAttemptId;
  }
  if (
    event.coordinates.toolOperationId
    && event.coordinates.toolOperationId !== state.toolOperationId
  ) {
    delete next.toolAttemptId;
  }

  return {
    kind: "applied",
    state: {
      ...next,
      ...(event.coordinates.turnId ? { turnId: event.coordinates.turnId } : {}),
      ...(event.coordinates.stepId ? { stepId: event.coordinates.stepId } : {}),
      ...(event.coordinates.providerAttemptId
        ? { providerAttemptId: event.coordinates.providerAttemptId }
        : {}),
      ...(event.coordinates.toolOperationId
        ? { toolOperationId: event.coordinates.toolOperationId }
        : {}),
      ...(event.coordinates.toolAttemptId
        ? { toolAttemptId: event.coordinates.toolAttemptId }
        : {}),
    },
  };
}

/**
 * Execution events are authoritative for runtime/audit facts only. Public and
 * model-visible conversation content remains authoritative in HistoryStore.
 */
export function executionEventProjectsTo(
  _event: ExecutionEvent,
  surface: ExecutionProjectionSurface,
): boolean {
  return surface !== "model_history";
}

export function isTerminalExecutionEvent(event: ExecutionEvent): boolean {
  return event.type === "run.completed"
    || event.type === "run.failed"
    || event.type === "run.cancelled"
    || event.type === "run.interrupted";
}

/** Project durable execution facts into the existing ephemeral UI contract. */
export function executionEventToRuntimeEvent(event: ExecutionEvent): RuntimeEvent | null {
  if (event.type === "runtime.event") {
    const runtimeEvent = (event as ExecutionEvent<"runtime.event">).payload.event;
    // Canonical Run and Approval events own identities and lifecycle state.
    if (runtimeEvent.type === "approval_required") return null;
    if (runtimeEvent.type === "status" && (
      runtimeEvent.status === "running"
      || runtimeEvent.status === "completed"
      || runtimeEvent.status === "failed"
      || runtimeEvent.status === "interrupted"
      || runtimeEvent.status === "closed"
    )) return null;
    return runtimeEvent;
  }
  if (event.type === "run.created") {
    const created = event as ExecutionEvent<"run.created">;
    return {
      type: "extension",
      name: "run_started",
      payload: {
        runId: event.runId,
        turnId: event.coordinates.turnId,
        threadId: created.payload.threadId,
        replayed: false,
      },
    };
  }
  if (event.type === "run.started") return { type: "status", status: "running" };
  if (event.type === "run.completed") return { type: "status", status: "completed" };
  if (event.type === "run.failed") {
    const failed = event as ExecutionEvent<"run.failed">;
    return { type: "status", status: "failed", message: failed.payload.error };
  }
  if (event.type === "run.cancelled" || event.type === "run.interrupted") {
    const stopped = event as ExecutionEvent<"run.cancelled" | "run.interrupted">;
    return { type: "status", status: "interrupted", message: stopped.payload.reason };
  }
  if (event.type === "context.truncated") {
    return {
      type: "extension",
      name: event.type,
      payload: (event as ExecutionEvent<"context.truncated">).payload,
    };
  }
  if (event.type === "approval.requested") {
    const requested = (event as ExecutionEvent<"approval.requested">).payload;
    if (!requested.callId) return null;
    return {
      type: "approval_required",
      requestId: requested.requestId,
      callId: requested.callId,
      risk: requested.risk,
      kind: requested.kind,
      policyVersion: requested.policyVersion,
      freshHumanRequired: requested.freshHumanRequired,
    };
  }
  return null;
}
