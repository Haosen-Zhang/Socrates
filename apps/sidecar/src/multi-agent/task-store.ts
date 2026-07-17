import type { Database } from "bun:sqlite";
import { hashStructuredPlan, reduceTaskState, type StructuredPlan, type TaskState, type TaskStateEvent } from "@socrates/core";

type TaskRow = {
  id: string; session_id: string; prompt: string; state: TaskState; resume_from_state: string | null;
  attempt_no: number; config_json: string; discussion_cutoff: number | null; execution_agent_id: string | null;
  approved_plan_version: number | null; approved_plan_hash: string | null; terminal_reason: string | null;
  created_at: string; updated_at: string; completed_at: string | null;
};

export interface MultiTaskRecord {
  id: string; sessionId: string; prompt: string; state: TaskState; resumeFrom: string | null;
  attemptNo: number; config: MultiTaskConfig; discussionCutoff: number | null; executionAgentId: string | null;
  approvedPlanVersion: number | null; approvedPlanHash: string | null; terminalReason: string | null;
  createdAt: string; updatedAt: string; completedAt: string | null;
}

export interface MultiTaskConfig {
  speakingOrder: string[];
  maxRounds: number;
  synthesizerId: string;
  executionAgentId: string;
  effortByAgent?: Record<string, string>;
}

export interface PlanVersionRecord {
  id: string; taskId: string; version: number; parentVersion: number | null;
  content: StructuredPlan; contentHash: string; evidenceHash: string; createdBy: string; status: string; createdAt: string;
}

const toTask = (row: TaskRow): MultiTaskRecord => ({
  id: row.id, sessionId: row.session_id, prompt: row.prompt, state: row.state, resumeFrom: row.resume_from_state,
  attemptNo: row.attempt_no, config: JSON.parse(row.config_json), discussionCutoff: row.discussion_cutoff,
  executionAgentId: row.execution_agent_id, approvedPlanVersion: row.approved_plan_version,
  approvedPlanHash: row.approved_plan_hash, terminalReason: row.terminal_reason,
  createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at,
});

export class MultiTaskStore {
  constructor(private readonly db: Database) {}

  create(input: { sessionId: string; prompt: string; config: MultiTaskConfig }): MultiTaskRecord {
    const session = this.db.query<{ mode: string; workspace_id: string | null; status: string }, [string]>("SELECT mode, workspace_id, status FROM sessions WHERE id = ?").get(input.sessionId);
    if (!session || session.mode !== "multi_agent") throw new Error("multi_agent_session_required");
    if (!session.workspace_id) throw new Error("multi_agent_workspace_required");
    if (!input.prompt.trim()) throw new Error("multi_agent_prompt_required");
    if (!Number.isInteger(input.config.maxRounds) || input.config.maxRounds < 1 || input.config.maxRounds > 20) throw new Error("multi_agent_rounds_invalid");
    const snapshots = this.db.query<{ agent_id: string; execution_eligible: number }, [string]>("SELECT agent_id, execution_eligible FROM session_agents WHERE session_id = ? ORDER BY position").all(input.sessionId);
    const ids = new Set(snapshots.map((item) => item.agent_id));
    if (input.config.speakingOrder.length < 2 || new Set(input.config.speakingOrder).size !== input.config.speakingOrder.length || input.config.speakingOrder.some((id) => !ids.has(id))) throw new Error("multi_agent_order_invalid");
    if (!ids.has(input.config.synthesizerId)) throw new Error("multi_agent_synthesizer_invalid");
    if (!snapshots.some((item) => item.agent_id === input.config.executionAgentId && item.execution_eligible === 1)) throw new Error("multi_agent_executor_invalid");
    const id = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.query(`INSERT INTO multi_tasks
        (id, session_id, prompt, state, attempt_no, config_json, execution_agent_id, created_at, updated_at)
        VALUES (?, ?, ?, 'preparing', 1, ?, ?, ?, ?)`)
        .run(id, input.sessionId, input.prompt.trim(), JSON.stringify(input.config), input.config.executionAgentId, now, now);
      this.db.query("INSERT INTO multi_task_attempts (id, task_id, attempt_no, status, started_at) VALUES (?, ?, 1, 'active', ?)").run(attemptId, id, now);
      this.db.query("INSERT INTO session_messages (id, session_id, role, content, status, created_at) VALUES (?, ?, 'user', ?, 'completed', ?)").run(messageId, input.sessionId, input.prompt.trim(), now);
      this.db.query("INSERT INTO message_parts (id, message_id, ordinal, type, text) VALUES (?, ?, 0, 'text', ?)").run(crypto.randomUUID(), messageId, input.prompt.trim());
      this.db.query("UPDATE sessions SET status = 'preparing', updated_at = ? WHERE id = ?").run(now, input.sessionId);
    })();
    return this.get(id)!;
  }

  get(id: string): MultiTaskRecord | null {
    const row = this.db.query<TaskRow, [string]>("SELECT * FROM multi_tasks WHERE id = ?").get(id);
    return row ? toTask(row) : null;
  }

  list(sessionId: string): MultiTaskRecord[] {
    return this.db.query<TaskRow, [string]>("SELECT * FROM multi_tasks WHERE session_id = ? ORDER BY created_at DESC").all(sessionId).map(toTask);
  }

  listTurns(taskId: string): Array<Record<string, unknown>> {
    return this.db.query<{
      id: string; phase: string; round: number; participant_index: number; agent_id: string; snapshot_json: string;
      status: string; content: string | null; usage_json: string | null; error: string | null; outcome_certainty: string;
    }, [string]>("SELECT id, phase, round, participant_index, agent_id, snapshot_json, status, content, usage_json, error, outcome_certainty FROM multi_turns WHERE task_id = ? ORDER BY participant_index").all(taskId).map((row) => ({
      id: row.id, phase: row.phase, round: row.round, participantIndex: row.participant_index, agentId: row.agent_id,
      snapshot: JSON.parse(row.snapshot_json), status: row.status, content: row.content,
      usage: row.usage_json ? JSON.parse(row.usage_json) : null, error: row.error, outcomeCertainty: row.outcome_certainty,
    }));
  }

  transition(id: string, event: TaskStateEvent): MultiTaskRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.applyTransition(id, event);
      this.db.exec("COMMIT");
      return this.get(id)!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  resumeNewAttempt(id: string, options: { allowOutcomeUnknown?: boolean } = {}): MultiTaskRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.get(id);
      if (!task) throw new Error("multi_task_not_found");
      if (task.state !== "paused" || !task.resumeFrom) throw new Error("multi_task_not_paused");
      if (this.hasOutcomeUnknown(id) && !options.allowOutcomeUnknown) throw new Error("multi_task_outcome_unknown_requires_review");
      const now = new Date().toISOString();
      this.db.query("UPDATE multi_task_attempts SET status = 'paused', ended_at = ? WHERE task_id = ? AND attempt_no = ? AND status = 'active'")
        .run(now, id, task.attemptNo);
      this.db.query("UPDATE multi_tasks SET attempt_no = attempt_no + 1, terminal_reason = NULL WHERE id = ?").run(id);
      this.db.query("INSERT INTO multi_task_attempts (id, task_id, attempt_no, status, started_at) VALUES (?, ?, ?, 'active', ?)")
        .run(crypto.randomUUID(), id, task.attemptNo + 1, now);
      this.applyTransition(id, { type: "resume" });
      this.db.exec("COMMIT");
      return this.get(id)!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  currentAttemptId(taskId: string): string {
    const task = this.get(taskId);
    if (!task) throw new Error("multi_task_not_found");
    const row = this.db.query<{ id: string }, [string, number]>("SELECT id FROM multi_task_attempts WHERE task_id = ? AND attempt_no = ?").get(taskId, task.attemptNo);
    if (!row) throw new Error("multi_attempt_not_found");
    return row.id;
  }

  beginTurn(input: { taskId: string; stableKey: string; phase: string; round: number; participantIndex: number; agentId: string; snapshot: unknown }): { id: string; status: string; content: string | null; outcomeCertainty: string } {
    const existing = this.db.query<{ id: string; status: string; content: string | null; outcome_certainty: string }, [string]>("SELECT id, status, content, outcome_certainty FROM multi_turns WHERE stable_key = ?").get(input.stableKey);
    if (existing) return { id: existing.id, status: existing.status, content: existing.content, outcomeCertainty: existing.outcome_certainty };
    const id = crypto.randomUUID();
    this.db.query(`INSERT INTO multi_turns
      (id, task_id, attempt_id, stable_key, phase, round, participant_index, agent_id, snapshot_json, status, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`)
      .run(id, input.taskId, this.currentAttemptId(input.taskId), input.stableKey, input.phase, input.round, input.participantIndex, input.agentId, JSON.stringify(input.snapshot), new Date().toISOString());
    return { id, status: "running", content: null, outcomeCertainty: "known" };
  }

  completedLogicalTurn(input: { taskId: string; phase: string; round: number; participantIndex: number; agentId: string }): { id: string; content: string; usage: unknown } | null {
    const row = this.db.query<{ id: string; content: string; usage_json: string | null }, [string, string, number, number, string]>(`
      SELECT id, content, usage_json FROM multi_turns
      WHERE task_id = ? AND phase = ? AND round = ? AND participant_index = ? AND agent_id = ?
        AND status = 'completed' AND content IS NOT NULL
      ORDER BY completed_at DESC LIMIT 1
    `).get(input.taskId, input.phase, input.round, input.participantIndex, input.agentId);
    return row ? { id: row.id, content: row.content, usage: row.usage_json ? JSON.parse(row.usage_json) : null } : null;
  }

  hasOutcomeUnknown(taskId: string): boolean {
    return this.db.query<{ present: number }, [string]>("SELECT EXISTS(SELECT 1 FROM multi_turns WHERE task_id = ? AND outcome_certainty = 'unknown') AS present").get(taskId)?.present === 1;
  }

  completeTurn(id: string, content: string, usage: unknown): void {
    this.db.query("UPDATE multi_turns SET status = 'completed', content = ?, usage_json = ?, completed_at = ? WHERE id = ? AND status = 'running'")
      .run(content, usage ? JSON.stringify(usage) : null, new Date().toISOString(), id);
  }

  failTurn(id: string, error: string, outcomeCertainty: "known" | "unknown" = "known"): void {
    this.db.query("UPDATE multi_turns SET status = 'failed', error = ?, outcome_certainty = ?, completed_at = ? WHERE id = ? AND status = 'running'")
      .run(error, outcomeCertainty, new Date().toISOString(), id);
  }

  markRunningTurnsUnknown(): number {
    return this.db.query("UPDATE multi_turns SET status = 'interrupted', outcome_certainty = 'unknown', error = 'sidecar_restarted' WHERE status = 'running'").run().changes;
  }

  recoverInterrupted(): { turns: number; tasks: number } {
    let turns = 0;
    let tasks = 0;
    this.db.transaction(() => {
      turns = this.markRunningTurnsUnknown();
      tasks = this.db.query(`UPDATE multi_tasks SET state = 'paused', resume_from_state = state,
        terminal_reason = 'sidecar_restarted', updated_at = ?
        WHERE state IN ('preparing', 'discussing', 'synthesizing', 'executing', 'awaiting_tool_approval')`)
        .run(new Date().toISOString()).changes;
      this.db.query(`UPDATE sessions SET status = 'paused', updated_at = ?
        WHERE id IN (SELECT session_id FROM multi_tasks WHERE state = 'paused' AND terminal_reason = 'sidecar_restarted')`)
        .run(new Date().toISOString());
    })();
    return { turns, tasks };
  }

  async addPlan(input: { taskId: string; content: StructuredPlan; createdBy: string; parentVersion?: number | null }): Promise<PlanVersionRecord> {
    const version = (this.db.query<{ next: number }, [string]>("SELECT COALESCE(MAX(version), 0) + 1 AS next FROM plan_versions WHERE task_id = ?").get(input.taskId)?.next ?? 1);
    const contentHash = await hashStructuredPlan(input.content);
    const evidenceHash = await hashStructuredPlan({ ...input.content, objective: "evidence", summary: "evidence", steps: [] });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.query(`INSERT INTO plan_versions
      (id, task_id, version, parent_version, content_json, content_hash, evidence_hash, created_by, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(id, input.taskId, version, input.parentVersion ?? null, JSON.stringify(input.content), contentHash, evidenceHash, input.createdBy, now);
    return this.getPlan(input.taskId, version)!;
  }

  getPlan(taskId: string, version?: number): PlanVersionRecord | null {
    const row = version === undefined
      ? this.db.query<any, [string]>("SELECT * FROM plan_versions WHERE task_id = ? ORDER BY version DESC LIMIT 1").get(taskId)
      : this.db.query<any, [string, number]>("SELECT * FROM plan_versions WHERE task_id = ? AND version = ?").get(taskId, version);
    return row ? { id: row.id, taskId: row.task_id, version: row.version, parentVersion: row.parent_version, content: JSON.parse(row.content_json), contentHash: row.content_hash, evidenceHash: row.evidence_hash, createdBy: row.created_by, status: row.status, createdAt: row.created_at } : null;
  }

  decidePlan(input: { taskId: string; version: number; hash: string; clientDecisionKey: string; decision: "approve_exact_plan" | "request_replan" | "reject"; reason?: string }): { id: string; decision: string; replayed: boolean } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = this.db.query<{ id: string; task_id: string; plan_hash: string; decision: string }, [string]>("SELECT id, task_id, plan_hash, decision FROM plan_decisions WHERE client_decision_key = ?").get(input.clientDecisionKey);
      if (duplicate) {
        if (duplicate.task_id !== input.taskId || duplicate.plan_hash !== input.hash || duplicate.decision !== input.decision) throw new Error("plan_decision_key_conflict");
        this.db.exec("COMMIT");
        return { id: duplicate.id, decision: duplicate.decision, replayed: true };
      }
      const plan = this.getPlan(input.taskId, input.version);
      if (!plan || plan.contentHash !== input.hash || plan.status !== "pending") throw new Error("plan_hash_mismatch");
      const task = this.get(input.taskId);
      if (!task || task.state !== "awaiting_plan_approval") throw new Error("plan_not_awaiting_approval");
      const id = crypto.randomUUID();
      this.db.query("INSERT INTO plan_decisions (id, task_id, plan_version, plan_hash, client_decision_key, decision, reason, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, input.taskId, input.version, input.hash, input.clientDecisionKey, input.decision, input.reason ?? null, new Date().toISOString());
      this.db.query("UPDATE plan_versions SET status = ? WHERE id = ?").run(input.decision === "approve_exact_plan" ? "approved" : input.decision === "reject" ? "rejected" : "superseded", plan.id);
      if (input.decision === "approve_exact_plan") this.db.query("UPDATE multi_tasks SET approved_plan_version = ?, approved_plan_hash = ? WHERE id = ?").run(plan.version, plan.contentHash, input.taskId);
      this.applyTransition(input.taskId, input.decision === "approve_exact_plan" ? { type: "approve_plan" } : input.decision === "reject" ? { type: "cancel", reason: "plan_rejected" } : { type: "request_replan" });
      this.db.exec("COMMIT");
      return { id, decision: input.decision, replayed: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private applyTransition(id: string, event: TaskStateEvent): void {
    const current = this.get(id);
    if (!current) throw new Error("multi_task_not_found");
    const next = reduceTaskState({ state: current.state, resumeFrom: current.resumeFrom as never, terminalReason: current.terminalReason }, event);
    const now = new Date().toISOString();
    const terminal = ["failed", "cancelled", "completed"].includes(next.state);
    this.db.query("UPDATE multi_tasks SET state = ?, resume_from_state = ?, terminal_reason = ?, updated_at = ?, completed_at = ? WHERE id = ?")
      .run(next.state, next.resumeFrom, next.terminalReason, now, terminal ? now : null, id);
    this.db.query("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?").run(next.state, now, current.sessionId);
    if (terminal) this.db.query("UPDATE multi_task_attempts SET status = ?, ended_at = ? WHERE task_id = ? AND attempt_no = ?")
      .run(next.state, now, id, current.attemptNo);
  }
}
