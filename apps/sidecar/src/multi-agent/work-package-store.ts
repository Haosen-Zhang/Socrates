import type { Database } from "bun:sqlite";
import { validateWorkPackages, type WorkPackageDefinition, type WorkPackageState } from "@socrates/core";

export interface WorkPackageRecord extends WorkPackageDefinition {
  taskId: string;
  planVersion: number;
  state: WorkPackageState;
  attemptNo: number;
  runId: string | null;
  result: string | null;
  failureReason: string | null;
  reviewNotes: string | null;
  queueReason: string | null;
  reworkCount: number;
  executorProfile: Record<string, unknown>;
  reviewerProfile: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

type PackageRow = { id: string; task_id: string; plan_version: number; definition_json: string; state: WorkPackageState; attempt_no: number; run_id: string | null; result: string | null; failure_reason: string | null; review_notes: string | null; rework_count: number; created_at: string; updated_at: string };
const toPackage = (row: PackageRow): WorkPackageRecord => ({ ...JSON.parse(row.definition_json), id: row.id, taskId: row.task_id, planVersion: row.plan_version, state: row.state, attemptNo: row.attempt_no, runId: row.run_id, result: row.result, failureReason: row.failure_reason === "workspace_write_lease_busy" ? null : row.failure_reason, queueReason: row.failure_reason === "workspace_write_lease_busy" ? row.failure_reason : null, reviewNotes: row.review_notes, reworkCount: row.rework_count, createdAt: row.created_at, updatedAt: row.updated_at });

export class WorkPackageStore {
  constructor(private readonly db: Database) {}

  validateDefinitions(taskId: string, definitions: WorkPackageDefinition[]): void {
    const task = this.db.query<{ session_id: string }, [string]>("SELECT session_id FROM multi_tasks WHERE id = ?").get(taskId);
    if (!task) throw new Error("multi_task_not_found");
    const members = this.db.query<{ agent_id: string; execution_eligible: number }, [string]>("SELECT agent_id, execution_eligible FROM session_agents WHERE session_id = ?").all(task.session_id);
    const errors = validateWorkPackages(definitions, members.map((m) => m.agent_id));
    if (definitions.some((p) => !members.some((m) => m.agent_id === p.executorAgentId && m.execution_eligible === 1))) errors.push("work_package_executor_not_eligible");
    if (errors.length) throw new Error(errors[0]);
    const existing = this.list(taskId);
    if (existing.some((p) => p.attemptNo > 0)) throw new Error("work_packages_execution_started");
  }

  replacePlan(taskId: string, version: number, definitions: WorkPackageDefinition[]): void {
    this.validateDefinitions(taskId, definitions);
    const task = this.db.query<{ session_id: string; config_json: string }, [string]>("SELECT session_id, config_json FROM multi_tasks WHERE id = ?").get(taskId)!;
    const frozen = (JSON.parse(task.config_json) as { memberProfiles?: Record<string, Record<string, unknown>> }).memberProfiles;
    const profile = (agentId: string | null) => agentId ? frozen?.[agentId] ?? JSON.parse(this.db.query<{ snapshot_json: string }, [string,string]>("SELECT snapshot_json FROM session_agents WHERE session_id = ? AND agent_id = ?").get(task.session_id, agentId)!.snapshot_json) as Record<string, unknown> : null;
    this.db.transaction(() => {
      this.db.query("DELETE FROM work_packages WHERE task_id = ?").run(taskId);
      const now = new Date().toISOString();
      for (const definition of definitions) {
        const resolved = { ...definition, executorProfile: profile(definition.executorAgentId), reviewerProfile: profile(definition.reviewerAgentId), id: `${taskId}/${definition.id}`, dependencies: definition.dependencies.map((id) => `${taskId}/${id}`) };
        this.db.query(`INSERT INTO work_packages (id, task_id, plan_version, definition_json, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(resolved.id, taskId, version, JSON.stringify(resolved), resolved.dependencies.length ? "waiting" : "ready", now, now);
      }
    })();
  }

  get(id: string): WorkPackageRecord | null {
    const row = this.db.query<PackageRow, [string]>("SELECT * FROM work_packages WHERE id = ?").get(id);
    return row ? toPackage(row) : null;
  }

  list(taskId: string): WorkPackageRecord[] {
    return this.db.query<PackageRow, [string]>("SELECT * FROM work_packages WHERE task_id = ? ORDER BY rowid").all(taskId).map(toPackage);
  }

  ready(taskId: string): WorkPackageRecord[] {
    const all = this.list(taskId);
    const completed = new Set(all.filter((p) => p.state === "completed").map((p) => p.id));
    for (const item of all) if (item.state === "waiting" && item.dependencies.every((id) => completed.has(id))) this.updateState(item.id, "ready");
    return this.list(taskId).filter((p) => p.state === "ready");
  }

  start(id: string): WorkPackageRecord {
    const item = this.get(id);
    if (!item || item.state !== "ready") throw new Error("work_package_not_ready");
    if (!item.dependencies.every((dep) => this.get(dep)?.state === "completed")) throw new Error("work_package_dependency_incomplete");
    const attemptNo = item.attemptNo + 1;
    const runId = `package:${id}:${attemptNo}`;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.query("UPDATE work_packages SET state = 'running', attempt_no = ?, run_id = ?, failure_reason = NULL, updated_at = ? WHERE id = ?").run(attemptNo, runId, now, id);
      this.db.query("INSERT INTO work_package_attempts (id, package_id, attempt_no, run_id, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)").run(runId, id, attemptNo, runId, now);
    })();
    return this.get(id)!;
  }

  finish(id: string, outcome: { status: "completed" | "failed" | "cancelled" | "budget_stopped"; runId: string; result: string; reason?: string }): void {
    const item = this.get(id);
    if (!item || item.runId !== outcome.runId || !["running", "awaiting_approval"].includes(item.state)) throw new Error("work_package_run_mismatch");
    const now = new Date().toISOString();
    const state = outcome.status === "completed" && item.reviewerAgentId ? "awaiting_review" : outcome.status;
    this.db.transaction(() => {
      this.db.query("UPDATE work_packages SET state = ?, result = ?, failure_reason = ?, updated_at = ? WHERE id = ?").run(state, outcome.result, outcome.reason ?? null, now, id);
      this.db.query("UPDATE work_package_attempts SET status = ?, result = ?, failure_reason = ?, completed_at = ? WHERE run_id = ?").run(outcome.status, outcome.result, outcome.reason ?? null, now, outcome.runId);
    })();
  }

  review(id: string, verdict: "approve" | "request_changes" | "invalid", notes: string): void {
    const item = this.get(id);
    if (!item || item.state !== "awaiting_review") throw new Error("work_package_not_awaiting_review");
    const rework = verdict === "request_changes" && item.reworkCount < 1;
    const state = verdict === "approve" ? "completed" : rework ? "ready" : "failed";
    const reason = verdict === "invalid" ? "review_output_invalid" : verdict === "request_changes" && !rework ? "review_rework_limit" : null;
    this.db.query("UPDATE work_packages SET state = ?, review_notes = ?, rework_count = ?, failure_reason = ?, updated_at = ? WHERE id = ?").run(state, notes, item.reworkCount + (rework ? 1 : 0), reason, new Date().toISOString(), id);
  }

  setQueueReason(id: string, reason: "workspace_write_lease_busy" | null): void {
    this.db.query("UPDATE work_packages SET failure_reason = ?, updated_at = ? WHERE id = ? AND state = 'running'").run(reason, new Date().toISOString(), id);
  }

  updateState(id: string, state: WorkPackageState): void {
    this.db.query("UPDATE work_packages SET state = ?, updated_at = ? WHERE id = ?").run(state, new Date().toISOString(), id);
  }

  retry(id: string, confirmOutcomeUnknown = false): WorkPackageRecord {
    const item = this.get(id);
    if (!item || !["failed", "budget_stopped"].includes(item.state)) throw new Error("work_package_retry_not_required");
    if (item.failureReason === "execution_outcome_unknown" && !confirmOutcomeUnknown) throw new Error("outcome_unknown_confirmation_required");
    // An invalid review retries the read-only review, preserving completed side effects.
    this.updateState(id, item.failureReason === "review_output_invalid" ? "awaiting_review" : "ready");
    return this.get(id)!;
  }

  cancelQueued(taskId: string): number {
    return this.db.query("UPDATE work_packages SET state = 'cancelled', failure_reason = 'user_cancelled', updated_at = ? WHERE task_id = ? AND state IN ('waiting','ready','awaiting_review','budget_stopped')").run(new Date().toISOString(), taskId).changes;
  }

  recoverInterrupted(): number {
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const interrupted = this.db.query<PackageRow, []>("SELECT * FROM work_packages WHERE state IN ('running','awaiting_approval')").all();
      for (const item of interrupted) {
        const terminal = item.run_id ? this.db.query<{ type: string; payload_json: string }, [string]>(`
          SELECT type, payload_json FROM runtime_events WHERE run_id = ? AND schema_version = 1
            AND type IN ('run.completed','run.failed','run.cancelled','run.interrupted') ORDER BY seq DESC LIMIT 1
        `).get(item.run_id) : null;
        const payload = terminal ? JSON.parse(terminal.payload_json) as { error?: string; reason?: string } : {};
        const budgetReason = terminal?.type === "run.interrupted" && typeof payload.reason === "string"
          && (payload.reason === "budget_exhausted" || payload.reason.startsWith("cost_budget_")) ? payload.reason : null;
        const definition = JSON.parse(item.definition_json) as WorkPackageDefinition;
        const result = item.run_id ? this.db.query<{ content: string }, [string]>(`
          SELECT content FROM session_messages WHERE run_id = ? AND role = 'assistant' AND kind = 'text'
          ORDER BY COALESCE(sequence, rowid), rowid
        `).all(item.run_id).map((message) => message.content).join("") || item.result : item.result;
        const status = terminal?.type === "run.completed" ? "completed"
          : terminal?.type === "run.cancelled" ? "cancelled"
            : budgetReason ? "budget_stopped" : "failed";
        const state = status === "completed" && definition.reviewerAgentId ? "awaiting_review" : status;
        const reason = status === "completed" ? null : status === "budget_stopped" ? budgetReason
          : terminal?.type === "run.failed" ? payload.error ?? "execution_failed"
            : terminal?.type === "run.cancelled" ? payload.reason ?? "user_cancelled" : "execution_outcome_unknown";
        this.db.query("UPDATE work_packages SET state = ?, result = ?, failure_reason = ?, updated_at = ? WHERE id = ?")
          .run(state, result, reason, now, item.id);
        if (item.run_id) {
          this.db.query("UPDATE work_package_attempts SET status = ?, result = ?, failure_reason = ?, completed_at = ? WHERE run_id = ?")
            .run(status, result, reason, now, item.run_id);
          this.db.query("UPDATE approval_requests SET status = 'expired' WHERE task_id = ? AND status = 'pending'").run(item.run_id);
        }
      }
      return interrupted.length;
    })();
  }

  attempts(id: string): Array<Record<string, unknown>> {
    return this.db.query<Record<string, unknown>, [string]>("SELECT * FROM work_package_attempts WHERE package_id = ? ORDER BY attempt_no").all(id);
  }

  summary(taskId: string) {
    const all = this.list(taskId);
    return {
      completed: all.filter((p) => p.state === "completed").map((p) => ({ id: p.id, title: p.title, agentId: p.executorAgentId, result: p.result })),
      unfinished: all.filter((p) => p.state !== "completed").map((p) => ({ id: p.id, title: p.title, state: p.state, reason: p.failureReason ?? (p.state === "waiting" ? "dependency_incomplete" : null) })),
      verification: all.filter((p) => p.state === "completed").map((p) => ({ packageId: p.id, acceptanceCriteria: p.acceptanceCriteria, reviewerAgentId: p.reviewerAgentId, reviewNotes: p.reviewNotes, result: p.result })),
      artifacts: all.flatMap((p) => {
        const outputs = this.db.query<{ id: string; task_id: string; canonical_json: string | null }, [string]>(`SELECT calls.id, calls.task_id, output.canonical_json FROM tool_calls calls
          JOIN tool_outputs output ON output.tool_call_id = calls.id
          JOIN work_package_attempts attempt ON attempt.run_id = calls.task_id
          WHERE attempt.package_id = ? AND calls.status = 'succeeded' AND calls.capability = 'workspace_write' AND output.is_error = 0`).all(p.id);
        return outputs.flatMap((output) => {
          if (!output.canonical_json) return [];
          try {
            const data = JSON.parse(output.canonical_json) as { path?: unknown; action?: unknown };
            return typeof data.path === "string" && data.action !== "deleted"
              ? [{ packageId: p.id, path: data.path, toolOperationId: output.id, runId: output.task_id, source: "persisted_tool_result" }]
              : [];
          } catch { return []; }
        });
      }),
    };
  }
}
