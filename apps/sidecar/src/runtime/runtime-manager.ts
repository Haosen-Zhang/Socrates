import type { Database } from "bun:sqlite";
import type {
  AgentRuntime,
  MessagePart,
  RuntimeConversationMessage,
  RuntimeEvent,
  RuntimeStatus,
} from "@socrates/core";
import type { EventStore } from "../store/event-store";

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
  private readonly active = new Map<string, { runtime: AgentRuntime; sessionId: string; agentId: string }>();

  constructor(private readonly db: Database, private readonly events: EventStore) {}

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
      this.active.set(id, { runtime, sessionId: input.sessionId, agentId: input.agentId });
      return this.get(id)!;
    } catch (error) {
      this.updateStatus(id, "failed");
      throw error;
    }
  }

  async run(runtimeSessionId: string, input: {
    taskId: string;
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
    try {
      for await (const event of active.runtime.start({
        prompt: input.prompt,
        parts: input.parts,
        messages: input.messages,
        signal: input.signal,
      })) {
        ordinal += 1;
        this.events.append({
          eventId: `${runtimeSessionId}:${ordinal}`,
          sessionId: active.sessionId,
          taskId: input.taskId,
          type: `runtime.${event.type}`,
          payload: { agentId: active.agentId, runtimeSessionId, event },
        });
        seen.push(event);
        await input.onEvent?.(event);
        if (event.type === "status") this.updateStatus(runtimeSessionId, event.status);
      }
      const handle = this.get(runtimeSessionId);
      if (handle?.status === "running") this.updateStatus(runtimeSessionId, "completed");
      return seen;
    } catch (error) {
      this.updateStatus(runtimeSessionId, input.signal?.aborted ? "interrupted" : "failed");
      this.events.append({
        eventId: `${runtimeSessionId}:terminal:${crypto.randomUUID()}`,
        sessionId: active.sessionId,
        taskId: input.taskId,
        type: "runtime.status",
        payload: { agentId: active.agentId, runtimeSessionId, event: { type: "status", status: this.get(runtimeSessionId)?.status, message: error instanceof Error ? error.message : String(error) } },
      });
      throw error;
    }
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
