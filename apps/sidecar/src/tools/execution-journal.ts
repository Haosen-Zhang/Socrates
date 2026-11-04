import type { Database } from "bun:sqlite";
import { normalizeWorkspaceRelativePath, StructuredExecutionError, type ExecutionErrorDetail, type ExecutionEventInput, type ToolContext } from "@socrates/core";
import { ExecutionEventStore } from "../store/execution-event-store";
import { WorkspacePathPolicy } from "../workspace/path-policy";
import { sha256, type MutationRecovery, type MutationRequest } from "../workspace/mutation-evidence";
import { interruptedToolOutcome } from "./recovery-outcome";

type WorkspaceMutationCall = { id: string; name: string; input_json: string; workspace_identity: string };

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

  result(context: ToolContext, attemptId: string, status: string, output: { preview: string; byteSize: number; truncated: boolean; canonicalJson?: string; storageKey?: string }, error?: ExecutionErrorDetail, willRetry = false): void {
    this.commit(context, `tool-result:${attemptId}`, "tool.attempt.result", {
      status, isError: Boolean(error), ...(error ? { error } : {}), willRetry,
    }, () => {
      const now = new Date().toISOString();
      this.db.query("UPDATE tool_attempts SET status = ?, error_json = ?, completed_at = ? WHERE id = ?")
        .run(status, error ? JSON.stringify(error) : null, now, attemptId);
      if (willRetry) return;
      this.db.query(`INSERT INTO tool_outputs (tool_call_id, preview_text, byte_size, truncated, is_error, canonical_json, storage_key)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(context.callId, output.preview, output.byteSize, Number(output.truncated), Number(Boolean(error)), output.canonicalJson ?? null, output.storageKey ?? null);
      this.db.query("UPDATE tool_calls SET status = ?, error = ?, error_detail_json = ?, updated_at = ? WHERE id = ?")
        .run(status, error?.message ?? null, error ? JSON.stringify(error) : null, now, context.callId);
    }, attemptId);
    // The filesystem and SQL are separate transactions. Proof must survive
    // every failed result checkpoint; cleanup starts only after commit returns.
    if (status === "succeeded" && !error && !willRetry) this.cleanupCommittedMutation(context.callId);
  }

  /** Startup, or a stopped Run only. Never invokes a tool or reuses its approval. */
  recoverInterrupted(runId?: string): number {
    const rows = this.db.query<{
      id: string; session_id: string; task_id: string; turn_id: string; step_id: string | null;
      agent_id: string; status: string; idempotency: string; capability: string | null;
      name: string; input_json: string; workspace_identity: string;
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
        this.db.transaction(() => {
          this.db.query("UPDATE tool_calls SET status = ? WHERE id = ?").run(known.is_error ? "failed" : "succeeded", row.id);
          this.db.query("UPDATE approval_requests SET status = 'expired' WHERE subject_id = ? AND status IN ('pending', 'allowed')").run(row.id);
        })();
        if (!known.is_error) this.cleanupCommittedMutation(row.id);
        continue;
      }
      const started = row.status === "running";
      const fallback = interruptedToolOutcome(started, row.idempotency, row.capability);
      const recovery = started && row.capability === "workspace_write" ? this.inspectWorkspaceMutation(row) : null;
      const verified = recovery?.outcome === "applied";
      const notApplied = recovery?.outcome === "not_applied";
      const status = verified ? "succeeded" : notApplied || !started ? "cancelled" : "outcome_unknown";
      const outcome = recovery ? {
        code: verified ? "TOOL_RECOVERED_APPLIED" : notApplied ? "TOOL_MUTATION_NOT_APPLIED" : "TOOL_OUTCOME_UNKNOWN",
        disposition: recovery.disposition,
        message: verified
          ? "The workspace mutation was verified from durable filesystem evidence. The tool body was not repeated."
          : notApplied
            ? "The requested filesystem publication was not applied. Staging or parent directories may remain. Request a new operation and fresh approval if still needed."
            : "The workspace mutation could not be verified. Inspect its recovery evidence or ask the user before any new mutation. The tool body was not repeated.",
        recovery,
      } : fallback;
      const attemptId = row.latest_attempt_id ?? `${row.id}:attempt:recovered`;
      const preview = JSON.stringify(outcome);
      this.commit(context, `tool-recovered:${row.id}`, status === "outcome_unknown" ? "tool.outcome_unknown" : "tool.attempt.result",
        status === "outcome_unknown" ? { code: outcome.code, disposition: outcome.disposition } : { status, isError: !verified }, () => {
          const now = new Date().toISOString();
          this.db.query(`INSERT OR IGNORE INTO tool_attempts (id, tool_operation_id, attempt_no, status, started_at)
            VALUES (?, ?, 1, 'checkpointed', ?)`).run(attemptId, row.id, now);
          this.db.query("UPDATE tool_attempts SET status = ?, error_json = ?, completed_at = ? WHERE id = ?")
            .run(status, verified ? null : preview, now, attemptId);
          this.db.query(`INSERT INTO tool_outputs (tool_call_id, preview_text, byte_size, truncated, is_error, canonical_json)
            VALUES (?, ?, ?, 0, ?, ?)`).run(row.id, preview, Buffer.byteLength(preview), Number(!verified), preview);
          this.db.query("UPDATE tool_calls SET status = ?, error = ?, recovery_disposition = ?, updated_at = ? WHERE id = ?")
            .run(status, verified ? null : started ? outcome.code : "sidecar_restarted", outcome.disposition, now, row.id);
          this.db.query("UPDATE approval_requests SET status = 'expired' WHERE subject_id = ? AND status IN ('pending', 'allowed')").run(row.id);
        }, attemptId);
      if (verified) this.cleanupCommittedMutation(row.id);
    }
    // Close the crash window after a durable success but before best-effort
    // cleanup. Existing terminal results remain authoritative and unchanged.
    try {
      const completed = this.db.query<{ id: string }, [string | null, string | null, string | null]>(`SELECT id FROM tool_calls
      WHERE status = 'succeeded' AND capability = 'workspace_write'
        AND (? IS NULL OR task_id = ? OR task_id IN
          (SELECT runtime_sessions.agent_session_id FROM runtime_sessions
            JOIN agent_runs ON agent_runs.runtime_session_id = runtime_sessions.id WHERE agent_runs.id = ?))`)
      .all(runId ?? null, runId ?? null, runId ?? null);
      for (const call of completed) this.cleanupCommittedMutation(call.id);
    } catch { /* Startup cleanup is best-effort; committed outcomes stay authoritative. */ }
    return rows.length;
  }

  private cleanupCommittedMutation(callId: string): void {
    try {
      const call = this.db.query<WorkspaceMutationCall, [string]>(`SELECT tool_calls.* FROM tool_calls
        JOIN tool_outputs ON tool_outputs.tool_call_id = tool_calls.id
        WHERE tool_calls.id = ? AND tool_calls.status = 'succeeded'
          AND tool_calls.capability = 'workspace_write' AND tool_outputs.is_error = 0`).get(callId);
      if (!call) return;
      const scope = this.workspaceMutationScope(call);
      scope?.policy.finalizeCommittedMutation(scope.request);
    } catch { /* Durable success is never downgraded by cleanup failure. */ }
  }

  private inspectWorkspaceMutation(call: WorkspaceMutationCall): MutationRecovery | null {
    try {
      const scope = this.workspaceMutationScope(call);
      return scope ? scope.policy.recoverMutation(scope.request) : null;
    } catch (error) {
      return { disposition: "recovery_blocked", outcome: "unknown", reason: error instanceof Error ? error.message : "workspace_recovery_failed" };
    }
  }

  private workspaceMutationScope(call: WorkspaceMutationCall): { policy: WorkspacePathPolicy; request: MutationRequest } | null {
    const supported = new Set(["write_file", "create_directory", "copy_path", "move_path", "delete_path", "create_archive", "create_document", "create_spreadsheet"]);
    if (!supported.has(call.name)) return null;
    const workspace = this.db.query<{ canonical_path: string }, [string]>("SELECT canonical_path FROM workspaces WHERE identity_hash = ?").get(call.workspace_identity);
    // A tool name or a path alone never supplies workspace authority.
    if (!workspace) return null;
    const input: unknown = JSON.parse(call.input_json);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_recovery_input_invalid");
    const value = input as Record<string, unknown>;
    const policy = new WorkspacePathPolicy(workspace.canonical_path);
    if (sha256(policy.canonicalRoot) !== call.workspace_identity) throw new Error("workspace_recovery_identity_changed");
    const request: MutationRequest = { operationId: call.id, kind: "create", path: "" };
    const path = call.name === "copy_path" ? value.destination : call.name === "move_path" ? value.source : value.path;
    if (typeof path !== "string") throw new Error("workspace_recovery_input_invalid");
    request.path = normalizeWorkspaceRelativePath(path);
    if (call.name === "write_file") {
      if (typeof value.content !== "string") throw new Error("workspace_recovery_input_invalid");
      request.kind = "write";
      request.expectedNewSha256 = sha256(value.content);
    } else if (call.name === "delete_path") request.kind = "delete";
    else if (call.name === "move_path") {
      if (typeof value.destination !== "string") throw new Error("workspace_recovery_input_invalid");
      request.kind = "move";
      request.destination = normalizeWorkspaceRelativePath(value.destination);
    }
    return { policy, request };
  }
}
