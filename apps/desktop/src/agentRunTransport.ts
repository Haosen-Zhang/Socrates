import { isTerminalExecutionEvent, type ExecutionEvent } from "@socrates/core";

const ACTIVE_RUN_STATUSES = new Set(["preparing", "running", "awaiting_approval"]);

export interface AgentRunStatusView {
  status: string;
  error: string | null;
}

export interface ActiveAgentRunObserver {
  sessionId: string;
  controller: AbortController;
  promise: Promise<boolean>;
}

export function captureActiveAgentRun(
  runId: string | null,
  ...registries: Array<ReadonlyMap<string, ActiveAgentRunObserver>>
): { sessionId: string; runId: string } | null {
  if (!runId) return null;
  for (const registry of registries) {
    const observer = registry.get(runId);
    if (observer) return { sessionId: observer.sessionId, runId };
  }
  return null;
}

export class RetryableAgentRunProjectionError extends Error {
  constructor(readonly cause: unknown) {
    super("retryable_agent_run_projection");
  }
}

/** Stop observation before a view projection is cleared; this never cancels the Run. */
export async function stopAgentObservers(
  observers: Map<string, ActiveAgentRunObserver>,
): Promise<void> {
  const active = [...observers.entries()];
  for (const [, observer] of active) observer.controller.abort();
  await Promise.allSettled(active.map(([, observer]) => observer.promise));
  for (const [runId, observer] of active) {
    if (observers.get(runId) === observer) observers.delete(runId);
  }
}

export function agentRunStateAfterObservation(
  runId: string,
  run: AgentRunStatusView | null,
  transportError: string | null,
): { agentRunning: boolean; activeAgentRunId: string | null; agentError: string | null } {
  if (!run || ACTIVE_RUN_STATUSES.has(run.status)) {
    return {
      agentRunning: true,
      activeAgentRunId: runId,
      agentError: transportError,
    };
  }
  return {
    agentRunning: false,
    activeAgentRunId: null,
    agentError: run.status === "failed"
      ? run.error
      : run.status === "completed" ? null : transportError,
  };
}

export async function pollAgentRunUntilTerminal(
  load: () => Promise<AgentRunStatusView>,
  continuePolling: () => boolean,
  wait: (milliseconds: number) => Promise<void>,
  intervalMs = 1_000,
): Promise<AgentRunStatusView | null> {
  while (continuePolling()) {
    try {
      const run = await load();
      if (!continuePolling()) return null;
      if (!ACTIVE_RUN_STATUSES.has(run.status)) return run;
    } catch {
      // A transient status transport failure must not discard the only
      // cancellation handle for a Run that is still owned by the sidecar.
    }
    await wait(intervalMs);
  }
  return null;
}

export async function observeDurableRun(input: {
  runId: string;
  afterSeq: number;
  open(afterSeq: number): AsyncIterable<ExecutionEvent>;
  shouldContinue(): boolean;
  onEvent(event: ExecutionEvent): void | Promise<void>;
  wait(milliseconds: number): Promise<void>;
  retryDelayMs?: number;
}): Promise<{ lastSeq: number; terminal: boolean }> {
  class ProjectionFailure {
    constructor(readonly cause: unknown) {}
  }
  let lastSeq = input.afterSeq;
  while (input.shouldContinue()) {
    let replayGap = false;
    let retryProjection = false;
    try {
      for await (const event of input.open(lastSeq)) {
        if (event.runId !== input.runId) throw new Error("execution_event_run_mismatch");
        if (event.seq <= lastSeq) continue;
        if (event.seq !== lastSeq + 1) {
          replayGap = true;
          break;
        }
        try {
          await input.onEvent(event);
        } catch (error) {
          if (error instanceof RetryableAgentRunProjectionError) {
            retryProjection = true;
            break;
          }
          throw new ProjectionFailure(error);
        }
        if (replayGap) break;
        lastSeq = event.seq;
        if (isTerminalExecutionEvent(event)) return { lastSeq, terminal: true };
        if (!input.shouldContinue()) return { lastSeq, terminal: false };
      }
    } catch (error) {
      if (error instanceof ProjectionFailure) throw error.cause;
      if (error instanceof Error && error.message === "execution_event_run_mismatch") throw error;
      if (!input.shouldContinue()) return { lastSeq, terminal: false };
    }
    if (!input.shouldContinue()) return { lastSeq, terminal: false };
    await input.wait(replayGap && !retryProjection ? 0 : input.retryDelayMs ?? 250);
  }
  return { lastSeq, terminal: false };
}
