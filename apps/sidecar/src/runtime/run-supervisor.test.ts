import { describe, expect, it } from "bun:test";
import type { RuntimeEvent } from "@socrates/core";
import type { AgentRunInput, AgentRunResult } from "./single-agent-runner";
import { RunSupervisor } from "./run-supervisor";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("RunSupervisor", () => {
  it("keeps execution alive after the start request returns", async () => {
    const finish = deferred<void>();
    const completed = deferred<void>();
    let ownedSignal: AbortSignal | undefined;
    const runner = {
      recoverInterrupted: () => ({ runs: 0, approvals: 0 }),
      cancel: async () => {},
      run: async (input: AgentRunInput, emit: (event: RuntimeEvent) => void | Promise<void>) => {
        ownedSignal = input.signal;
        await emit({ type: "extension", name: "run_started", payload: {
          runId: "run-1", turnId: "turn-1", threadId: "thread-1", replayed: false,
        } });
        await finish.promise;
        await emit({ type: "text_delta", text: "done" });
        completed.resolve();
        return {
          id: "run-1", sessionId: input.sessionId, runtimeSessionId: "runtime-1",
          turnId: "turn-1", threadId: "thread-1", status: "completed",
        } satisfies AgentRunResult;
      },
    };
    const supervisor = new RunSupervisor(runner);

    const started = await supervisor.start({
      sessionId: "session-1", runtimeKind: "native_ai_sdk", prompt: "work",
    });
    finish.resolve();
    await completed.promise;
    await Promise.resolve();
    expect(ownedSignal?.aborted).toBe(false);
    expect(supervisor.get(started.runId)?.status).toBe("completed");
  });

  it("uses the run-owned controller only for explicit cancellation", async () => {
    const cancelled = deferred<void>();
    let signal: AbortSignal | undefined;
    const cancelCalls: string[] = [];
    const runner = {
      recoverInterrupted: () => ({ runs: 0, approvals: 0 }),
      cancel: async (runId: string) => {
        expect(signal?.aborted).toBe(false);
        cancelCalls.push(runId);
      },
      run: async (input: AgentRunInput, emit: (event: RuntimeEvent) => void | Promise<void>) => {
        signal = input.signal;
        await emit({ type: "extension", name: "run_started", payload: {
          runId: "run-2", turnId: "turn-2", threadId: "thread-2", replayed: false,
        } });
        input.signal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
        await cancelled.promise;
        return {
          id: "run-2", sessionId: input.sessionId, runtimeSessionId: "runtime-2",
          turnId: "turn-2", threadId: "thread-2", status: "cancelled",
        } satisfies AgentRunResult;
      },
    };
    const supervisor = new RunSupervisor(runner);
    const started = await supervisor.start({
      sessionId: "session-1", runtimeKind: "native_ai_sdk", prompt: "work",
    });

    await supervisor.cancel(started.runId);
    expect(signal?.aborted).toBe(true);
    expect(cancelCalls).toEqual([started.runId]);
  });

});
