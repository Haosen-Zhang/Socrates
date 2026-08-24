import type { RuntimeEvent } from "@socrates/core";
import type {
  AgentRunInput,
  AgentRunResult,
  AgentRunView,
} from "./single-agent-runner";

type EventObserver = (event: RuntimeEvent) => void | Promise<void>;

interface SupervisedRunner {
  run(input: AgentRunInput, emit: EventObserver): Promise<AgentRunResult>;
  cancel(runId: string): Promise<void>;
  recoverInterrupted(): { runs: number; approvals: number };
  getRun?(runId: string): AgentRunView | null;
}

interface Subscriber {
  observer: EventObserver;
  tail: Promise<void>;
  pending: number;
  dropped: Promise<void>;
  closed: boolean;
  drop(): void;
}

interface ActiveEntry {
  controller: AbortController;
  events: RuntimeEvent[];
  eventBytes: number;
  handoffGap: boolean;
  buffering: boolean;
  subscribers: Set<Subscriber>;
  completion: Promise<AgentRunResult>;
  result: AgentRunResult | null;
}

// Reserve one subscriber-queue slot for an explicit handoff gap marker.
const MAX_HANDOFF_EVENTS = 255;
const MAX_HANDOFF_BYTES = 512 * 1024;
const MAX_SUBSCRIBER_QUEUE = 256;

export interface AgentRunStart {
  runId: string;
  turnId: string;
  threadId: string;
  replayed: boolean;
}

export interface RunObservation {
  completion: Promise<AgentRunResult>;
  closed: Promise<void>;
  isClosed(): boolean;
  detach(): void;
  drained(): Promise<void>;
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
      events: [],
      eventBytes: 0,
      handoffGap: false,
      buffering: true,
      subscribers: new Set(),
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
      if (entry.buffering) this.bufferHandoffEvent(entry, event);
      for (const subscriber of entry.subscribers) this.enqueue(entry, subscriber, event);
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

  observe(runId: string, observer: EventObserver): RunObservation {
    const entry = this.runs.get(runId);
    if (!entry) throw new Error("agent_run_not_supervised");
    let dropSubscriber!: () => void;
    const dropped = new Promise<void>((resolve) => { dropSubscriber = resolve; });
    const subscriber: Subscriber = {
      observer,
      tail: Promise.resolve(),
      pending: 0,
      dropped,
      closed: false,
      drop: () => {
        if (subscriber.closed) return;
        subscriber.closed = true;
        dropSubscriber();
      },
    };
    entry.subscribers.add(subscriber);
    const [firstEvent, ...remainingEvents] = entry.events;
    if (firstEvent) this.enqueue(entry, subscriber, firstEvent);
    if (entry.handoffGap) {
      this.enqueue(entry, subscriber, {
        type: "extension",
        name: "observer_gap",
        payload: { reason: "handoff_buffer_exceeded" },
      });
    }
    for (const event of remainingEvents) this.enqueue(entry, subscriber, event);
    // The buffer only bridges the short POST -> GET hand-off. Durable replay
    // and reconnect from a sequence cursor belong to Phase 1C.
    entry.events = [];
    entry.eventBytes = 0;
    entry.buffering = false;
    return {
      completion: entry.completion,
      closed: subscriber.dropped,
      isClosed: () => subscriber.closed,
      detach: () => {
        entry.subscribers.delete(subscriber);
        subscriber.drop();
      },
      drained: () => Promise.race([subscriber.tail, subscriber.dropped]),
    };
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

  private enqueue(entry: ActiveEntry, subscriber: Subscriber, event: RuntimeEvent): void {
    if (subscriber.pending >= MAX_SUBSCRIBER_QUEUE) {
      entry.subscribers.delete(subscriber);
      subscriber.drop();
      return;
    }
    subscriber.pending += 1;
    subscriber.tail = subscriber.tail.then(() => (
      subscriber.closed ? undefined : subscriber.observer(event)
    )).then(
      () => { subscriber.pending -= 1; },
      () => {
        subscriber.pending -= 1;
        entry.subscribers.delete(subscriber);
        subscriber.drop();
      },
    );
  }

  private bufferHandoffEvent(entry: ActiveEntry, event: RuntimeEvent): void {
    const size = JSON.stringify(event).length;
    const identity = runStarted(event);
    if (!identity && size > MAX_HANDOFF_BYTES) {
      entry.handoffGap = true;
      return;
    }
    while (
      entry.events.length >= MAX_HANDOFF_EVENTS
      || entry.eventBytes + size > MAX_HANDOFF_BYTES
    ) {
      const preservesStarted = runStarted(entry.events[0]!) !== null;
      const index = preservesStarted ? 1 : 0;
      const removed = entry.events[index];
      if (!removed) {
        entry.handoffGap = true;
        return;
      }
      entry.events.splice(index, 1);
      entry.eventBytes -= JSON.stringify(removed).length;
      entry.handoffGap = true;
    }
    entry.events.push(event);
    entry.eventBytes += size;
  }

  private retainFinished(runId: string): void {
    this.finishedRuns.push(runId);
    while (this.finishedRuns.length > 128) {
      const expired = this.finishedRuns.shift();
      if (expired) this.runs.delete(expired);
    }
  }
}
