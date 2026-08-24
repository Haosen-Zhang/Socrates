import type { RuntimeEvent } from "@socrates/core";
import type {
  AgentRunInput,
  AgentRunResult,
  AgentRunView,
} from "./single-agent-runner";

interface SupervisedRunner {
  run(
    input: AgentRunInput,
    emit: (event: RuntimeEvent) => void | Promise<void>,
  ): Promise<AgentRunResult>;
  cancel(runId: string): Promise<void>;
  recoverInterrupted(): { runs: number; approvals: number };
  getRun?(runId: string): AgentRunView | null;
}

interface ActiveEntry {
  controller: AbortController;
  completion: Promise<AgentRunResult>;
  result: AgentRunResult | null;
}

export interface AgentRunStart {
  runId: string;
  turnId: string;
  threadId: string;
  replayed: boolean;
}

function runStarted(event: RuntimeEvent): AgentRunStart | null {
  if (event.type !== "extension" || event.name !== "run_started") return null;
  const payload = event.payload;
  if (!payload || typeof payload !== "object") return null;
  const values = payload as Record<string, unknown>;
  if (typeof values.runId !== "string" || typeof values.turnId !== "string"
    || typeof values.threadId !== "string") return null;
  return {
    runId: values.runId,
    turnId: values.turnId,
    threadId: values.threadId,
    replayed: values.replayed === true,
  };
}

export class RunSupervisor {
  private readonly runs = new Map<string, ActiveEntry>();
  private readonly finishedRuns: string[] = [];

  constructor(private readonly runner: SupervisedRunner) {}

  recoverInterrupted(): { runs: number; approvals: number } {
    return this.runner.recoverInterrupted();
  }

  async start(input: Omit<AgentRunInput, "signal">): Promise<AgentRunStart> {
    const controller = new AbortController();
    let settleStart!: (value: AgentRunStart) => void;
    let rejectStart!: (error: unknown) => void;
    let started = false;
    let supervisedRunId: string | null = null;
    const start = new Promise<AgentRunStart>((resolve, reject) => {
      settleStart = resolve;
      rejectStart = reject;
    });
    const entry: ActiveEntry = {
      controller,
      completion: Promise.resolve(null as unknown as AgentRunResult),
      result: null,
    };
    entry.completion = this.runner.run({ ...input, signal: controller.signal }, async (event) => {
      const identity = runStarted(event);
      if (identity && !started) {
        started = true;
        supervisedRunId = identity.runId;
        this.runs.set(identity.runId, entry);
        settleStart(identity);
      }
    }).then((result) => {
      entry.result = result;
      if (!started) rejectStart(new Error("agent_run_started_event_missing"));
      if (supervisedRunId) this.retainFinished(supervisedRunId);
      return result;
    }, (error) => {
      if (!started) rejectStart(error);
      if (supervisedRunId) this.retainFinished(supervisedRunId);
      throw error;
    });
    // A start-time failure has no observer yet; keep it from becoming an
    // unhandled rejection while still exposing it through the start promise.
    void entry.completion.catch(() => {});
    return start;
  }

  get(runId: string): AgentRunView | AgentRunResult | null {
    const durable = this.runner.getRun?.(runId);
    if (durable) return durable;
    const entry = this.runs.get(runId);
    return entry?.result ?? null;
  }

  async cancel(runId: string): Promise<void> {
    const entry = this.runs.get(runId);
    if (!entry) throw new Error("agent_run_not_active");
    // Journal cancellation intent before either cancellation mechanism can
    // produce a terminal event.
    await this.runner.cancel(runId);
    entry.controller.abort("user_cancelled");
  }

  async shutdown(): Promise<void> {
    const pending: Promise<AgentRunResult>[] = [];
    for (const entry of this.runs.values()) {
      if (entry.result) continue;
      entry.controller.abort("sidecar_shutdown");
      pending.push(entry.completion);
    }
    await Promise.allSettled(pending);
  }

  private retainFinished(runId: string): void {
    this.finishedRuns.push(runId);
    while (this.finishedRuns.length > 128) {
      const expired = this.finishedRuns.shift();
      if (expired) this.runs.delete(expired);
    }
  }
}
