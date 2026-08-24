import { describe, expect, it } from "bun:test";
import {
  advanceActiveAgentRunCursor,
  clearActiveAgentRunCursor,
  readActiveAgentRunCursor,
  selectActiveAgentRunCursor,
  writeActiveAgentRunCursor,
} from "./agentRunCursor";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("active Agent Run cursor", () => {
  it("round-trips a resumable Run identity and durable sequence", () => {
    const storage = memoryStorage();
    writeActiveAgentRunCursor(storage, {
      sessionId: "session-1",
      runId: "run-1",
      afterSeq: 7,
    });
    expect(readActiveAgentRunCursor(storage)).toEqual({
      sessionId: "session-1",
      runId: "run-1",
      afterSeq: 7,
    });
  });

  it("does not let an old Run clear a newer resume handle", () => {
    const storage = memoryStorage();
    writeActiveAgentRunCursor(storage, {
      sessionId: "session-1", runId: "new-run", afterSeq: 1,
    });
    clearActiveAgentRunCursor(storage, "old-run");
    expect(readActiveAgentRunCursor(storage)?.runId).toBe("new-run");
    clearActiveAgentRunCursor(storage, "new-run");
    expect(readActiveAgentRunCursor(storage)).toBeNull();
  });

  it("does not let a stale observer advance another Run's resume handle", () => {
    const storage = memoryStorage();
    writeActiveAgentRunCursor(storage, {
      sessionId: "session-1", runId: "new-run", afterSeq: 1,
    });
    expect(advanceActiveAgentRunCursor(storage, {
      sessionId: "session-1", runId: "old-run", afterSeq: 9,
    })).toBe(false);
    expect(readActiveAgentRunCursor(storage)).toEqual({
      sessionId: "session-1", runId: "new-run", afterSeq: 1,
    });
  });

  it("prefers the current in-memory owner over a stale persisted Run", () => {
    expect(selectActiveAgentRunCursor(
      { sessionId: "old-session", runId: "old-run", afterSeq: 9 },
      { sessionId: "current-session", runId: "current-run" },
    )).toEqual({
      sessionId: "current-session", runId: "current-run", afterSeq: 0,
    });
  });

  it("fails closed for malformed persisted data", () => {
    const storage = memoryStorage();
    storage.setItem("socrates.active-agent-run.v1", "not-json");
    expect(readActiveAgentRunCursor(storage)).toBeNull();
  });

  it("does not turn unavailable browser persistence into a Run failure", () => {
    const storage = {
      getItem: () => null,
      setItem: () => { throw new Error("storage unavailable"); },
      removeItem: () => { throw new Error("storage unavailable"); },
    };
    expect(writeActiveAgentRunCursor(storage, {
      sessionId: "session-1", runId: "run-1", afterSeq: 0,
    })).toBe(false);
    expect(() => clearActiveAgentRunCursor(storage, "run-1")).not.toThrow();
  });
});
