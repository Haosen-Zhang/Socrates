import type { Database } from "bun:sqlite";
import type { SessionEvent } from "@socrates/core";

type EventRow = {
  event_id: string;
  session_id: string;
  task_id: string | null;
  seq: number;
  type: string;
  payload_json: string;
  occurred_at: string;
};

function toEvent(row: EventRow): SessionEvent {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    taskId: row.task_id ?? undefined,
    seq: row.seq,
    type: row.type,
    payload: JSON.parse(row.payload_json),
    occurredAt: row.occurred_at,
  };
}

export class EventStore {
  constructor(private readonly db: Database) {}

  private insert(
    event: Omit<SessionEvent, "seq" | "occurredAt"> & { occurredAt?: string },
    project?: (event: SessionEvent) => void,
  ): SessionEvent {
    const last = this.db.query<{ seq: number | null }, [string]>("SELECT MAX(seq) AS seq FROM task_events WHERE session_id = ?").get(event.sessionId);
    const committed: SessionEvent = {
      ...event,
      seq: (last?.seq ?? 0) + 1,
      occurredAt: event.occurredAt ?? new Date().toISOString(),
    };
    this.db.query(`
      INSERT INTO task_events (event_id, session_id, task_id, seq, type, payload_json, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(committed.eventId, committed.sessionId, committed.taskId ?? null, committed.seq, committed.type, JSON.stringify(committed.payload), committed.occurredAt ?? new Date().toISOString());
    project?.(committed);
    return committed;
  }

  append(
    event: Omit<SessionEvent, "seq" | "occurredAt"> & { occurredAt?: string },
    project?: (event: SessionEvent) => void,
  ): SessionEvent {
    const existing = this.db.query<EventRow, [string]>("SELECT * FROM task_events WHERE event_id = ?").get(event.eventId);
    if (existing) return toEvent(existing);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const committed = this.insert(event, project);
      this.db.exec("COMMIT");
      return committed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      const duplicate = this.db.query<EventRow, [string]>("SELECT * FROM task_events WHERE event_id = ?").get(event.eventId);
      if (duplicate) return toEvent(duplicate);
      throw error;
    }
  }

  /** Use only when the caller owns the surrounding SQLite transaction. */
  appendInTransaction(
    event: Omit<SessionEvent, "seq" | "occurredAt"> & { occurredAt?: string },
    project?: (event: SessionEvent) => void,
  ): SessionEvent {
    const existing = this.db.query<EventRow, [string]>("SELECT * FROM task_events WHERE event_id = ?").get(event.eventId);
    return existing ? toEvent(existing) : this.insert(event, project);
  }

  listAfter(sessionId: string, after: number, limit = 500): SessionEvent[] {
    const boundedLimit = Math.max(1, Math.min(limit, 2_000));
    return this.db.query<EventRow, [string, number, number]>(
      "SELECT * FROM task_events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?",
    ).all(sessionId, after, boundedLimit).map(toEvent);
  }
}
