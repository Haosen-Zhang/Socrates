import { describe, expect, it } from "bun:test";
import { reduceSessionEvent } from "./events";

describe("session event reducer contract", () => {
  it("accepts the next event and ignores duplicates", () => {
    const first = reduceSessionEvent({ lastSeq: 0 }, { eventId: "e1", sessionId: "s", seq: 1, type: "task.started", payload: {} });
    expect(first).toEqual({ kind: "applied", state: { lastSeq: 1 } });
    if (first.kind !== "applied") throw new Error("expected applied event");
    expect(reduceSessionEvent(first.state, { eventId: "e1", sessionId: "s", seq: 1, type: "task.started", payload: {} }).kind).toBe("duplicate");
  });

  it("reports a gap instead of guessing state", () => {
    expect(reduceSessionEvent({ lastSeq: 3 }, { eventId: "e5", sessionId: "s", seq: 5, type: "x", payload: {} })).toEqual({
      kind: "gap",
      expectedSeq: 4,
      receivedSeq: 5,
    });
  });
});
