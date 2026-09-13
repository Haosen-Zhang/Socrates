import type { Database } from "bun:sqlite";
import type {
  AgentRuntime,
  ExecutionErrorDetail,
  MessagePart,
  RuntimeConversationMessage,
  RuntimeEvent,
  RuntimeStatus,
} from "@socrates/core";
import type { ExecutionEventStore } from "../store/execution-event-store";

export interface RuntimeSessionHandle {
  id: string;
  agentSessionId: string;
  runtimeKind: string;
  status: RuntimeStatus;
  createdAt: string;
  updatedAt: string;
}

type RuntimeRow = {
  id: string; agent_session_id: string; runtime_kind: string; status: RuntimeStatus;
  created_at: string; updated_at: string;
};
const toHandle = (row: RuntimeRow): RuntimeSessionHandle => ({
  id: row.id, agentSessionId: row.agent_session_id, runtimeKind: row.runtime_kind,
  status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
});

type RuntimeFactory = (input: RuntimeOpenInput) => AgentRuntime;

type ProviderLifecycle =
  | { name: "provider_attempt_started"; payload: { attemptNo: number } }
  | { name: "provider_attempt_failed"; payload: {
      attemptNo: number;
      error: ExecutionErrorDetail;
      outputStarted: boolean;
      willRetry: boolean;
    } }
  | { name: "provider_retry_scheduled"; payload: {
      failedAttemptNo: number;
      nextAttemptNo: number;
      delayMs: number;
      errorCode: string;
    } }
  | { name: "provider_attempt_completed"; payload: { attemptNo: number } }
  | { name: "provider_step_completed"; payload: Record<string, never> };

const PROVIDER_LIFECYCLE_NAMES = new Set<ProviderLifecycle["name"]>([
  "provider_attempt_started",
  "provider_attempt_failed",
  "provider_retry_scheduled",
  "provider_attempt_completed",
  "provider_step_completed",
]);

function providerLifecycleOf(event: RuntimeEvent): ProviderLifecycle | null {
  if (event.type !== "extension" || !PROVIDER_LIFECYCLE_NAMES.has(event.name as ProviderLifecycle["name"])) {
    return null;
  }
  if (!event.payload || typeof event.payload !== "object") {
    throw new Error("provider_lifecycle_payload_invalid");
  }
  return { name: event.name, payload: event.payload } as ProviderLifecycle;
}

export interface RuntimeOpenInput {
  runtimeKind: string;
  agentSessionId: string;
  sessionId: string;
  agentId: string;
  workspaceId?: string;
  runtimeOptions?: Record<string, unknown>;
}

export class RuntimeManager {
  private readonly factories = new Map<string, RuntimeFactory>();
  private readonly active = new Map<string, {
    runtime: AgentRuntime;
    sessionId: string;
    agentId: string;
    journalBlocked: boolean;
  }>();

  constructor(private readonly db: Database, private readonly events: ExecutionEventStore) {}

  register(kind: string, factory: RuntimeFactory): void {
    if (this.factories.has(kind)) throw new Error(`duplicate_runtime:${kind}`);
    this.factories.set(kind, factory);
  }

  async open(input: RuntimeOpenInput): Promise<RuntimeSessionHandle> {
    const factory = this.factories.get(input.runtimeKind);
    if (!factory) throw new Error(`unknown_runtime:${input.runtimeKind}`);
    const runtime = factory(input);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.query(`
      INSERT INTO runtime_sessions (id, agent_session_id, runtime_kind, protocol_version, status, created_at, updated_at)
      VALUES (?, ?, ?, '1', 'opening', ?, ?)
    `).run(id, input.agentSessionId, input.runtimeKind, now, now);
    try {
      await runtime.open({ sessionId: input.sessionId, workspaceId: input.workspaceId });
      this.updateStatus(id, "ready");
      this.active.set(id, {
        runtime, sessionId: input.sessionId, agentId: input.agentId, journalBlocked: false,
      });
      return this.get(id)!;
    } catch (error) {
      this.updateStatus(id, "failed");
      throw error;
    }
  }

  async run(runtimeSessionId: string, input: {
    taskId: string;
    turnId?: string;
    prompt: string;
    parts?: MessagePart[];
    messages?: RuntimeConversationMessage[];
    signal?: AbortSignal;
    onEvent?: (event: RuntimeEvent) => void | Promise<void>;
  }): Promise<RuntimeEvent[]> {
    const active = this.active.get(runtimeSessionId);
    if (!active) throw new Error("runtime_not_active");
    this.updateStatus(runtimeSessionId, "running");
    const seen: RuntimeEvent[] = [];
    let ordinal = 0;
    let eventConsumerFailed = false;
    let stepNo = 0;
    let stepId: string | undefined;
    let providerAttemptId: string | undefined;
    let providerAttemptNo = 0;
    let lastProviderAttemptId: string | undefined;
    let providerState: "active" | "failed_retryable" | "failed_terminal" | "retry_scheduled" | "completed" | undefined;
    try {
      for await (const event of active.runtime.start({
        prompt: input.prompt,
        parts: input.parts,
        messages: input.messages,
        signal: input.signal,
      })) {
        ordinal += 1;
        const providerLifecycle = providerLifecycleOf(event);
        if (providerLifecycle) {
          if (!input.turnId) throw new Error("provider_lifecycle_turn_identity_missing");
          if (active.journalBlocked) throw new Error("execution_journal_blocked");
          if (providerLifecycle.name === "provider_attempt_started") {
            const { attemptNo } = providerLifecycle.payload;
            if (!Number.isSafeInteger(attemptNo) || attemptNo < 1 || providerAttemptId) {
              throw new Error("provider_attempt_transition_invalid");
            }
            if (!stepId) {
              if (attemptNo !== 1) throw new Error("provider_step_first_attempt_invalid");
              const nextStepNo = stepNo + 1;
              const nextStepId = `${input.taskId}:turn:${input.turnId}:step:${nextStepNo}`;
              this.events.append({
                eventId: `step-started:${nextStepId}`,
                sessionId: active.sessionId,
                runId: input.taskId,
                agentId: active.agentId,
                type: "step.started",
                coordinates: { turnId: input.turnId, stepId: nextStepId },
                payload: {},
              });
              stepNo = nextStepNo;
              stepId = nextStepId;
              providerAttemptNo = 0;
              lastProviderAttemptId = undefined;
              providerState = undefined;
            } else if (providerState !== "retry_scheduled") {
              throw new Error("provider_attempt_transition_invalid");
            }
            if (attemptNo !== providerAttemptNo + 1) throw new Error("provider_attempt_sequence_invalid");
            const nextProviderAttemptId = `${stepId}:provider:${attemptNo}`;
            this.events.append({
              eventId: `provider-attempt-started:${nextProviderAttemptId}`,
              sessionId: active.sessionId,
              runId: input.taskId,
              agentId: active.agentId,
              type: "provider.attempt.started",
              coordinates: {
                turnId: input.turnId,
                stepId,
                providerAttemptId: nextProviderAttemptId,
              },
              payload: { attemptNo },
            });
            providerAttemptNo = attemptNo;
            providerAttemptId = nextProviderAttemptId;
            providerState = "active";
          } else if (providerLifecycle.name === "provider_attempt_failed") {
            if (!stepId || !providerAttemptId || providerState !== "active"
              || providerLifecycle.payload.attemptNo !== providerAttemptNo) {
              throw new Error("provider_attempt_failure_transition_invalid");
            }
            this.events.append({
              eventId: `provider-attempt-failed:${providerAttemptId}`,
              sessionId: active.sessionId,
              runId: input.taskId,
              agentId: active.agentId,
              type: "provider.attempt.failed",
              coordinates: { turnId: input.turnId, stepId, providerAttemptId },
              payload: providerLifecycle.payload,
            });
            lastProviderAttemptId = providerAttemptId;
            providerAttemptId = undefined;
            providerState = providerLifecycle.payload.willRetry && !providerLifecycle.payload.outputStarted
              ? "failed_retryable"
              : "failed_terminal";
          } else if (providerLifecycle.name === "provider_retry_scheduled") {
            if (!stepId || providerAttemptId || !lastProviderAttemptId || providerState !== "failed_retryable"
              || providerLifecycle.payload.failedAttemptNo !== providerAttemptNo
              || providerLifecycle.payload.nextAttemptNo !== providerAttemptNo + 1) {
              throw new Error("provider_retry_transition_invalid");
            }
            this.events.append({
              eventId: `provider-retry:${lastProviderAttemptId}:${providerLifecycle.payload.nextAttemptNo}`,
              sessionId: active.sessionId,
              runId: input.taskId,
              agentId: active.agentId,
              type: "provider.retry_scheduled",
              coordinates: {
                turnId: input.turnId,
                stepId,
                providerAttemptId: lastProviderAttemptId,
              },
              payload: providerLifecycle.payload,
            });
            providerState = "retry_scheduled";
          } else if (providerLifecycle.name === "provider_attempt_completed") {
            if (!stepId || !providerAttemptId || providerState !== "active"
              || providerLifecycle.payload.attemptNo !== providerAttemptNo) {
              throw new Error("provider_attempt_completion_transition_invalid");
            }
            this.events.append({
              eventId: `provider-attempt-completed:${providerAttemptId}`,
              sessionId: active.sessionId,
              runId: input.taskId,
              agentId: active.agentId,
              type: "provider.attempt.completed",
              coordinates: { turnId: input.turnId, stepId, providerAttemptId },
              payload: providerLifecycle.payload,
            });
            lastProviderAttemptId = providerAttemptId;
            providerAttemptId = undefined;
            providerState = "completed";
          } else {
            if (!stepId || providerAttemptId || !lastProviderAttemptId || providerState !== "completed") {
              throw new Error("provider_step_completion_transition_invalid");
            }
            this.events.append({
              eventId: `step-completed:${stepId}`,
              sessionId: active.sessionId,
              runId: input.taskId,
              agentId: active.agentId,
              type: "step.completed",
              coordinates: { turnId: input.turnId, stepId },
              payload: {},
            });
            stepId = undefined;
            lastProviderAttemptId = undefined;
            providerState = undefined;
          }
        } else if (input.turnId && !active.journalBlocked) {
          this.events.append({
            eventId: `${runtimeSessionId}:${input.taskId}:${ordinal}`,
            sessionId: active.sessionId,
            runId: input.taskId,
            agentId: active.agentId,
            type: "runtime.event",
            coordinates: {
              turnId: input.turnId,
              ...(stepId ? { stepId } : {}),
              ...(providerAttemptId ? { providerAttemptId } : {}),
            },
            payload: { runtimeSessionId, event },
          });
        }
        if (providerLifecycle?.name === "provider_step_completed") continue;
        seen.push(event);
        try {
          await input.onEvent?.(event);
        } catch (error) {
          eventConsumerFailed = true;
          throw error;
        }
        if (event.type === "status") this.updateStatus(runtimeSessionId, event.status);
      }
      if (stepId) throw new Error("provider_step_terminal_missing");
      const handle = this.get(runtimeSessionId);
      if (handle?.status === "running") this.updateStatus(runtimeSessionId, "completed");
      return seen;
    } catch (error) {
      this.updateStatus(runtimeSessionId, input.signal?.aborted ? "interrupted" : "failed");
      const status = input.signal?.aborted ? "interrupted" : "failed";
      if (input.turnId && stepId && !active.journalBlocked) {
        this.events.append({
          eventId: `step-failed:${stepId}`,
          sessionId: active.sessionId,
          runId: input.taskId,
          agentId: active.agentId,
          type: "step.failed",
          coordinates: { turnId: input.turnId, stepId },
          payload: { error: error instanceof Error ? error.message : String(error) },
        });
      }
      if (input.turnId && !eventConsumerFailed && !active.journalBlocked) {
        this.events.append({
          eventId: `${runtimeSessionId}:${input.taskId}:terminal:${status}`,
          sessionId: active.sessionId,
          runId: input.taskId,
          agentId: active.agentId,
          type: "runtime.event",
          coordinates: { turnId: input.turnId },
          payload: {
            runtimeSessionId,
            event: {
              type: "status",
              status,
              message: error instanceof Error ? error.message : String(error),
            },
          },
        });
      }
      throw error;
    }
  }

  contextOverheadTokens(runtimeSessionId: string): number {
    const active = this.active.get(runtimeSessionId);
    if (!active) throw new Error("runtime_not_active");
    const value = active.runtime.contextOverheadTokens?.() ?? 0;
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  setExecutionJournalBlocked(runtimeSessionId: string, blocked: boolean): void {
    const active = this.active.get(runtimeSessionId);
    if (!active) throw new Error("runtime_not_active");
    active.journalBlocked = blocked;
  }

  async interrupt(runtimeSessionId: string): Promise<void> {
    const active = this.active.get(runtimeSessionId);
    if (!active) throw new Error("runtime_not_active");
    await active.runtime.interrupt();
    this.updateStatus(runtimeSessionId, "interrupted");
  }

  async answerApproval(runtimeSessionId: string, requestId: string, decision: "allow_once" | "allow_session" | "deny"): Promise<void> {
    const active = this.active.get(runtimeSessionId);
    if (!active) throw new Error("runtime_not_active");
    await active.runtime.answerApproval(requestId, decision);
  }

  async close(runtimeSessionId: string): Promise<void> {
    const active = this.active.get(runtimeSessionId);
    if (!active) return;
    try {
      await active.runtime.close();
      this.updateStatus(runtimeSessionId, "closed");
    } finally {
      this.active.delete(runtimeSessionId);
    }
  }

  recoverInterrupted(): number {
    return this.db.query(`
      UPDATE runtime_sessions SET status = 'interrupted', updated_at = ?
      WHERE status IN ('opening', 'ready', 'running', 'awaiting_approval')
    `).run(new Date().toISOString()).changes;
  }

  get(id: string): RuntimeSessionHandle | null {
    const row = this.db.query<RuntimeRow, [string]>("SELECT id, agent_session_id, runtime_kind, status, created_at, updated_at FROM runtime_sessions WHERE id = ?").get(id);
    return row ? toHandle(row) : null;
  }

  private updateStatus(id: string, status: RuntimeStatus): void {
    this.db.query("UPDATE runtime_sessions SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), id);
  }
}
