import type { Database } from "bun:sqlite";
import { StructuredExecutionError, type ExecutionErrorDetail, type ExecutionEventInput, type ToolContext } from "@socrates/core";
import { ExecutionEventStore } from "../store/execution-event-store";
import { interruptedToolOutcome } from "./recovery-outcome";

/** The journal and its SQL projection commit together, always outside the tool body. */
export class ToolExecutionJournal {
  constructor(private readonly db: Database, private readonly events = new ExecutionEventStore(db)) {}

  commit(context: ToolContext, eventId: string, type: ExecutionEventInput["type"], payload: ExecutionEventInput["payload"], project: () => void, attemptId?: string): void {
    try {
      if (!context.stepId) {
        this.db.transaction(project)();
        return;
      }
      this.events.append({
        eventId, sessionId: context.sessionId, runId: context.taskId, agentId: context.agentId,
        type, coordinates: { turnId: context.turnId, stepId: context.stepId,
          toolOperationId: context.callId, ...(attemptId ? { toolAttemptId: attemptId } : {}) }, payload,
      }, project);
    } catch (cause) {
      throw new StructuredExecutionError({ code: "TOOL_PERSISTENCE_FAILED", category: "persistence",
        phase: "tool_checkpoint", retryable: false, message: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  start(context: ToolContext, attemptNo: number): string {
    const id = `${context.callId}:attempt:${attemptNo}`;
    this.commit(context, `tool-checkpoint:${id}`, "tool.attempt.checkpointed", {}, () => {
      this.db.query(`INSERT INTO tool_attempts (id, tool_operation_id, attempt_no, status, started_at)
        VALUES (?, ?, ?, 'checkpointed', ?)`).run(id, context.callId, attemptNo, new Date().toISOString());
    }, id);
    this.commit(context, `tool-started:${id}`, "tool.attempt.started", {}, () => {
      this.db.query("UPDATE tool_attempts SET status = 'running' WHERE id = ?").run(id);
      this.db.query("UPDATE tool_calls SET status = 'running', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), context.callId);
    }, id);
    return id;
  }

  result(context: ToolContext, attemptId: string, status: string, output: { preview: string; byteSize: number; truncated: boolean }, error?: ExecutionErrorDetail, willRetry = false): void {
    this.commit(context, `tool-result:${attemptId}`, "tool.attempt.result", {
      status, isError: Boolean(error), ...(error ? { error } : {}), willRetry,
    }, () => {
      const now = new Date().toISOString();
      this.db.query("UPDATE tool_attempts SET status = ?, error_json = ?, completed_at = ? WHERE id = ?")
        .run(status, error ? JSON.stringify(error) : null, now, attemptId);
      if (willRetry) return;
      this.db.query(`INSERT INTO tool_outputs (tool_call_id, preview_text, byte_size, truncated, is_error)
        VALUES (?, ?, ?, ?, ?)`).run(context.callId, output.preview, output.byteSize, Number(output.truncated), Number(Boolean(error)));
      this.db.query("UPDATE tool_calls SET status = ?, error = ?, error_detail_json = ?, updated_at = ? WHERE id = ?")
        .run(status, error?.message ?? null, error ? JSON.stringify(error) : null, now, context.callId);
    }, attemptId);
  }

  /** Startup, or a stopped Run only. Never invokes a tool or reuses its approval. */
  recoverInterrupted(runId?: string): number {
    const rows = this.db.query<{
      id: string; session_id: string; task_id: string; turn_id: string; step_id: string | null;
      agent_id: string; status: string; idempotency: string; capability: string | null;
      latest_attempt_id: string | null; latest_attempt_status: string | null;
    }, [string | null, string | null, string | null]>(`SELECT tool_calls.*,
      (SELECT id FROM tool_attempts WHERE tool_operation_id = tool_calls.id ORDER BY attempt_no DESC LIMIT 1) AS latest_attempt_id,
      (SELECT status FROM tool_attempts WHERE tool_operation_id = tool_calls.id ORDER BY attempt_no DESC LIMIT 1) AS latest_attempt_status
      FROM tool_calls WHERE status IN ('running', 'queued', 'awaiting_approval')
        AND (? IS NULL OR task_id = ? OR task_id IN
          (SELECT runtime_sessions.agent_session_id FROM runtime_sessions
            JOIN agent_runs ON agent_runs.runtime_session_id = runtime_sessions.id WHERE agent_runs.id = ?))`)
      .all(runId ?? null, runId ?? null, runId ?? null);
    for (const row of rows) {
      const context: ToolContext = { callId: row.id, sessionId: row.session_id, taskId: row.task_id,
        turnId: row.turn_id, ...(row.step_id ? { stepId: row.step_id } : {}), agentId: row.agent_id,
        mode: "single_agent", phase: "executing", signal: new AbortController().signal };
      // Older versions could commit output separately from status. A durable
      // output is stronger evidence than the old running projection.
      const known = this.db.query<{ is_error: number }, [string]>("SELECT is_error FROM tool_outputs WHERE tool_call_id = ?").get(row.id);
      if (known) {
        this.db.query("UPDATE tool_calls SET status = ? WHERE id = ?").run(known.is_error ? "failed" : "succeeded", row.id);
        continue;
      }
      const started = row.status === "running";
      const outcome = interruptedToolOutcome(started, row.idempotency, row.capability);
      const attemptId = row.latest_attempt_id ?? `${row.id}:attempt:recovered`;
      const preview = JSON.stringify(outcome);
      this.commit(context, `tool-recovered:${row.id}`, started ? "tool.outcome_unknown" : "tool.attempt.result",
        started ? { code: outcome.code, disposition: outcome.disposition } : { status: "cancelled", isError: true }, () => {
          const now = new Date().toISOString();
          this.db.query(`INSERT OR IGNORE INTO tool_attempts (id, tool_operation_id, attempt_no, status, started_at)
            VALUES (?, ?, 1, 'checkpointed', ?)`).run(attemptId, row.id, now);
          this.db.query("UPDATE tool_attempts SET status = ?, error_json = ?, completed_at = ? WHERE id = ?")
            .run(started ? "outcome_unknown" : "cancelled", preview, now, attemptId);
          this.db.query(`INSERT INTO tool_outputs (tool_call_id, preview_text, byte_size, truncated, is_error)
            VALUES (?, ?, ?, 0, 1)`).run(row.id, preview, Buffer.byteLength(preview));
          this.db.query("UPDATE tool_calls SET status = ?, error = ?, recovery_disposition = ?, updated_at = ? WHERE id = ?")
            .run(started ? "outcome_unknown" : "cancelled", started ? outcome.code : "sidecar_restarted", outcome.disposition, now, row.id);
          this.db.query("UPDATE approval_requests SET status = 'expired' WHERE subject_id = ? AND status IN ('pending', 'allowed')").run(row.id);
        }, attemptId);
    }
    return rows.length;
  }
}
