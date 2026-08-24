import type { Database } from "bun:sqlite";
import {
  EXECUTION_EVENT_SCHEMA_VERSION,
  isExecutionEventType,
  validateExecutionCoordinates,
  type ExecutionCoordinates,
  type ExecutionEvent,
  type ExecutionEventInput,
  type ExecutionEventType,
} from "@socrates/core";

type ExecutionEventRow = {
  id: string;
  session_id: string | null;
  run_id: string;
  turn_id: string | null;
  step_id: string | null;
  provider_attempt_id: string | null;
  tool_operation_id: string | null;
  tool_attempt_id: string | null;
  agent_id: string;
  seq: number;
  schema_version: number;
  type: string;
  payload_json: string;
  occurred_at: string;
};

type CursorWaiter = {
  after: number;
  resolve(): void;
};

function coordinatesOf(row: ExecutionEventRow): ExecutionCoordinates {
  return {
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(row.step_id ? { stepId: row.step_id } : {}),
    ...(row.provider_attempt_id ? { providerAttemptId: row.provider_attempt_id } : {}),
    ...(row.tool_operation_id ? { toolOperationId: row.tool_operation_id } : {}),
    ...(row.tool_attempt_id ? { toolAttemptId: row.tool_attempt_id } : {}),
  };
}

function toEvent(row: ExecutionEventRow): ExecutionEvent {
  if (row.schema_version !== EXECUTION_EVENT_SCHEMA_VERSION) {
    throw new Error(`unsupported_execution_event_schema:${row.schema_version}`);
  }
  if (!row.session_id) throw new Error("execution_event_session_missing");
  if (!isExecutionEventType(row.type)) throw new Error(`unsupported_execution_event_type:${row.type}`);
  return {
    schemaVersion: EXECUTION_EVENT_SCHEMA_VERSION,
    eventId: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    agentId: row.agent_id,
    seq: row.seq,
    type: row.type,
    coordinates: coordinatesOf(row),
    payload: JSON.parse(row.payload_json),
    occurredAt: row.occurred_at,
  };
}

function canonicalJsonValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonValue(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("execution_event_json_invalid");
  return canonicalJsonValue(JSON.parse(serialized));
}

function sameEvent<T extends ExecutionEventType>(
  existing: ExecutionEvent,
  input: ExecutionEventInput<T>,
): boolean {
  return existing.sessionId === input.sessionId
    && existing.runId === input.runId
    && existing.agentId === input.agentId
    && existing.type === input.type
    && canonicalJson(existing.coordinates) === canonicalJson(input.coordinates)
    && canonicalJson(existing.payload) === canonicalJson(input.payload);
}

export class ExecutionEventStore {
  private readonly waiters = new Map<string, Set<CursorWaiter>>();

  constructor(private readonly db: Database) {}

  append<T extends ExecutionEventType>(
    input: ExecutionEventInput<T>,
    project?: (event: ExecutionEvent<T>) => void,
  ): ExecutionEvent<T> {
    for (const [name, value] of Object.entries({
      eventId: input.eventId,
      sessionId: input.sessionId,
      runId: input.runId,
      agentId: input.agentId,
    })) {
      if (typeof value !== "string" || !value) throw new Error(`execution_${name}_invalid`);
    }
    if (!isExecutionEventType(input.type)) {
      throw new Error(`unsupported_execution_event_type:${String(input.type)}`);
    }
    const coordinateErrors = validateExecutionCoordinates(input.type, input.coordinates);
    if (coordinateErrors[0]) throw new Error(coordinateErrors[0]);
    const legacyRun = this.db.query<{ found: number }, [string]>(`
      SELECT 1 AS found FROM runtime_events
      WHERE run_id = ? AND schema_version = 0 LIMIT 1
    `).get(input.runId);
    if (legacyRun) throw new Error("execution_event_legacy_run_quarantined");

    const duplicate = this.rowById(input.eventId);
    if (duplicate) {
      const event = toEvent(duplicate);
      if (!sameEvent(event, input)) throw new Error("execution_event_id_conflict");
      return event as ExecutionEvent<T>;
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const concurrentDuplicate = this.rowById(input.eventId);
      if (concurrentDuplicate) {
        const event = toEvent(concurrentDuplicate);
        if (!sameEvent(event, input)) throw new Error("execution_event_id_conflict");
        this.db.exec("COMMIT");
        return event as ExecutionEvent<T>;
      }
      const last = this.db.query<{ seq: number | null }, [string]>(
        "SELECT MAX(seq) AS seq FROM runtime_events WHERE run_id = ?",
      ).get(input.runId);
      const event: ExecutionEvent<T> = {
        ...input,
        schemaVersion: EXECUTION_EVENT_SCHEMA_VERSION,
        seq: (last?.seq ?? 0) + 1,
        occurredAt: input.occurredAt ?? new Date().toISOString(),
      };
      this.db.query(`
        INSERT INTO runtime_events
          (id, session_id, run_id, turn_id, step_id, provider_attempt_id,
           tool_operation_id, tool_attempt_id, agent_id, seq, schema_version,
           type, payload_json, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.eventId,
        event.sessionId,
        event.runId,
        event.coordinates.turnId ?? null,
        event.coordinates.stepId ?? null,
        event.coordinates.providerAttemptId ?? null,
        event.coordinates.toolOperationId ?? null,
        event.coordinates.toolAttemptId ?? null,
        event.agentId,
        event.seq,
        event.schemaVersion,
        event.type,
        JSON.stringify(event.payload),
        event.occurredAt,
      );
      this.db.query("UPDATE agent_runs SET event_seq = ? WHERE id = ?")
        .run(event.seq, event.runId);
      project?.(event);
      this.db.exec("COMMIT");
      this.notifyWaiters(event.runId, event.seq);
      return event;
    } catch (error) {
      this.db.exec("ROLLBACK");
      const committed = this.rowById(input.eventId);
      if (committed) {
        const event = toEvent(committed);
        if (!sameEvent(event, input)) throw new Error("execution_event_id_conflict");
        this.notifyWaiters(event.runId, event.seq);
        return event as ExecutionEvent<T>;
      }
      throw error;
    }
  }

  listAfter(runId: string, after: number, limit = 500): ExecutionEvent[] {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("invalid_execution_event_cursor");
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid_execution_event_limit");
    const boundedLimit = Math.max(1, Math.min(limit, 2_000));
    return this.db.query<ExecutionEventRow, [string, number, number]>(`
      SELECT * FROM runtime_events
      WHERE run_id = ? AND schema_version = 1 AND seq > ?
      ORDER BY seq LIMIT ?
    `).all(runId, after, boundedLimit).map(toEvent);
  }

  latestSeq(runId: string): number {
    const row = this.db.query<{ seq: number | null }, [string]>(`
      SELECT MAX(seq) AS seq FROM runtime_events
      WHERE run_id = ? AND schema_version = 1
    `).get(runId);
    return row?.seq ?? 0;
  }

  hasLegacyEvents(runId: string): boolean {
    return Boolean(this.db.query<{ found: number }, [string]>(`
      SELECT 1 AS found FROM runtime_events
      WHERE run_id = ? AND schema_version = 0 LIMIT 1
    `).get(runId));
  }

  waitForAppend(runId: string, after: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(after) || after < 0) {
      return Promise.reject(new Error("invalid_execution_event_cursor"));
    }
    if (signal?.aborted || this.latestSeq(runId) > after) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.waiters.get(runId) ?? new Set<CursorWaiter>();
      this.waiters.set(runId, waiters);
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        waiters.delete(waiter);
        if (waiters.size === 0) this.waiters.delete(runId);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const waiter: CursorWaiter = { after, resolve: finish };
      waiters.add(waiter);
      signal?.addEventListener("abort", finish, { once: true });
      // Close the read -> waiter registration race without polling.
      if (this.latestSeq(runId) > after) finish();
    });
  }

  private notifyWaiters(runId: string, seq: number): void {
    const waiters = this.waiters.get(runId);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (seq > waiter.after) waiter.resolve();
    }
  }

  private rowById(eventId: string): ExecutionEventRow | null {
    return this.db.query<ExecutionEventRow, [string]>(
      "SELECT * FROM runtime_events WHERE id = ?",
    ).get(eventId);
  }
}
