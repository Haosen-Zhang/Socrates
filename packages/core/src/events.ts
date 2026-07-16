export interface SessionEvent<T = unknown> {
  eventId: string;
  sessionId: string;
  taskId?: string;
  seq: number;
  type: string;
  payload: T;
  occurredAt?: string;
}

export interface SessionEventCursor {
  lastSeq: number;
}

export type EventReduceResult =
  | { kind: "applied"; state: SessionEventCursor }
  | { kind: "duplicate"; state: SessionEventCursor }
  | { kind: "gap"; expectedSeq: number; receivedSeq: number };

export function reduceSessionEvent(state: SessionEventCursor, event: SessionEvent): EventReduceResult {
  if (event.seq <= state.lastSeq) return { kind: "duplicate", state };
  if (event.seq !== state.lastSeq + 1) {
    return { kind: "gap", expectedSeq: state.lastSeq + 1, receivedSeq: event.seq };
  }
  return { kind: "applied", state: { lastSeq: event.seq } };
}
