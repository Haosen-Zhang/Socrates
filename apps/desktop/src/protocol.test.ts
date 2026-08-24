import { describe, expect, it } from "bun:test";
import { decodeExecutionEvent } from "./protocol";

describe("durable execution event decoder", () => {
  it("accepts a v1 event only when its SSE id matches the durable sequence", () => {
    expect(decodeExecutionEvent({
      schemaVersion: 1,
      eventId: "event-2",
      sessionId: "session-1",
      runId: "run-1",
      agentId: "agent-1",
      seq: 2,
      type: "run.completed",
      coordinates: {},
      payload: {},
      occurredAt: "2026-08-24T00:00:00.000Z",
      _sseId: "2",
    })?.seq).toBe(2);
    expect(decodeExecutionEvent({
      schemaVersion: 1,
      eventId: "event-2",
      sessionId: "session-1",
      runId: "run-1",
      agentId: "agent-1",
      seq: 2,
      type: "run.completed",
      coordinates: {},
      payload: {},
      occurredAt: "2026-08-24T00:00:00.000Z",
      _sseId: "3",
    })).toBeNull();
  });

  it("rejects unsupported schemas and invalid identity coordinates", () => {
    const base = {
      eventId: "event-1",
      sessionId: "session-1",
      runId: "run-1",
      agentId: "agent-1",
      seq: 1,
      type: "step.started",
      payload: {},
      occurredAt: "now",
      _sseId: "1",
    };
    expect(decodeExecutionEvent({ ...base, schemaVersion: 2, coordinates: {} })).toBeNull();
    expect(decodeExecutionEvent({
      ...base,
      schemaVersion: 1,
      coordinates: { turnId: "turn-1" },
    })).toBeNull();
  });
});
