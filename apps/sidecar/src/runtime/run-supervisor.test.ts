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
  it("keeps execution alive after its observer disconnects", async () => {
    const finish = deferred<void>();
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
    const received: RuntimeEvent[] = [];
    const observation = supervisor.observe(started.runId, (event) => { received.push(event); });
    observation.detach();

    finish.resolve();
    expect((await observation.completion).status).toBe("completed");
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

  it("bounds the handoff buffer when a caller never attaches", async () => {
    const completed = deferred<void>();
    const runner = {
      recoverInterrupted: () => ({ runs: 0, approvals: 0 }),
      cancel: async () => {},
      run: async (input: AgentRunInput, emit: (event: RuntimeEvent) => void | Promise<void>) => {
        await emit({ type: "extension", name: "run_started", payload: {
          runId: "run-buffer", turnId: "turn-buffer", threadId: "thread-buffer", replayed: false,
        } });
        for (let index = 0; index < 2_000; index += 1) {
          await emit({ type: "text_delta", text: String(index) });
        }
        completed.resolve();
        return {
          id: "run-buffer", sessionId: input.sessionId, runtimeSessionId: "runtime-buffer",
          turnId: "turn-buffer", threadId: "thread-buffer", status: "completed",
        } satisfies AgentRunResult;
      },
    };
    const supervisor = new RunSupervisor(runner);
    const started = await supervisor.start({
      sessionId: "session-1", runtimeKind: "native_ai_sdk", prompt: "work",
    });
    await completed.promise;
    const received: RuntimeEvent[] = [];
    const observation = supervisor.observe(started.runId, (event) => { received.push(event); });
    await observation.completion;
    await observation.drained();

    expect(received.length).toBeLessThanOrEqual(256);
    expect(received.some((event) => event.type === "extension" && event.name === "observer_gap"))
      .toBe(true);
  });

  it("drops a stalled observer after a bounded queue without blocking the Run", async () => {
    const publish = deferred<void>();
    const never = new Promise<void>(() => {});
    const runner = {
      recoverInterrupted: () => ({ runs: 0, approvals: 0 }),
      cancel: async () => {},
      run: async (input: AgentRunInput, emit: (event: RuntimeEvent) => void | Promise<void>) => {
        await emit({ type: "extension", name: "run_started", payload: {
          runId: "run-slow", turnId: "turn-slow", threadId: "thread-slow", replayed: false,
        } });
        await publish.promise;
        for (let index = 0; index < 2_000; index += 1) {
          await emit({ type: "text_delta", text: String(index) });
        }
        return {
          id: "run-slow", sessionId: input.sessionId, runtimeSessionId: "runtime-slow",
          turnId: "turn-slow", threadId: "thread-slow", status: "completed",
        } satisfies AgentRunResult;
      },
    };
    const supervisor = new RunSupervisor(runner);
    const started = await supervisor.start({
      sessionId: "session-1", runtimeKind: "native_ai_sdk", prompt: "work",
    });
    const observation = supervisor.observe(started.runId, () => never);
    publish.resolve();

    expect((await observation.completion).status).toBe("completed");
    await observation.closed;
    expect(observation.isClosed()).toBe(true);
  });
});
