import { assertTaskWorkflowCompatible } from "../services/workflow-compatibility";
import type { RoomCollaborationSettings } from "@socrates/core";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { WorkPackageStore } from "./work-package-store";
import { validateStructuredPlan, validateWorkPackages } from "@socrates/core";
import { hashStructuredPlan, reduceTaskState, type ReasoningEffort, type StructuredPlan, type TaskState, type TaskStateEvent, type TokenUsage } from "@socrates/core";
import { UsageCollector, normalizeTokenUsage } from "../services/usage-collector";
import type { HistoryStore } from "../store/history-store";

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
  clientRequestId?: string;
  costRootTaskId?: string;
  teamExecution?: boolean;
  routeDecisionId?: string;
  adaptiveAttemptId?: string;
  allowedAgentIds?: string[];
  routingReviewerId?: string | null;
  frozenCollaboration?: RoomCollaborationSettings;
  targetAgentIds?: string[];
  contextMessageCursor?: number;
  inputContext?: string;
  memberProfiles?: Record<string, Record<string, unknown>>;
  speakingOrder: string[];
  maxRounds: number;
  synthesizerId: string;
  executionAgentId: string;
  effortByAgent?: Record<string, string>;
  fallbackOrderByAgent?: Record<string, string[]>;
  /** Durable user-requested revision boundary; never replaced by the initial plan on resume. */
  pendingRevision?: { instruction: string; parentVersion: number; ordinal: number; synthesizerId: string };
}

type MultiTaskCreateProjection = {
  id: string;
  attemptId: string;
  sessionId: string;
  prompt: string;
  config: MultiTaskConfig;
  createdAt: string;
};

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
  private readonly usage: UsageCollector;
  constructor(private readonly db: Database, private readonly history?: HistoryStore) {
    this.usage = new UsageCollector(db);
    history?.registerProjectionHandler("multi_task.create", (record) => {
      this.projectCreate(record.projectionIntent!.payload as unknown as MultiTaskCreateProjection);
    });
  }

  async create(input: { sessionId: string; prompt: string; config: MultiTaskConfig }): Promise<MultiTaskRecord> {
    const session = this.db.query<{ kind:string; mode: string; workspace_id: string | null; status: string; strategy:string|null }, [string]>("SELECT kind, mode, workspace_id, status, json_extract(collaboration_json, '$.strategy') AS strategy FROM sessions WHERE id = ?").get(input.sessionId);
    const frozenRoute=input.config.routeDecisionId?this.db.query("SELECT id FROM routing_decisions WHERE id=? AND root_task_id=? AND room_id=?").get(input.config.routeDecisionId,input.config.costRootTaskId??"",input.sessionId):null;
    if(input.config.routeDecisionId&&!frozenRoute)throw new Error("routing_decision_missing");
    if (!session || (frozenRoute?session.kind!=="cowork":session.mode !== "multi_agent" && !(session.kind === "cowork" && session.strategy === "team"))) throw new Error("multi_agent_session_required");
    if (!session.workspace_id) throw new Error("multi_agent_workspace_required");
    if (!input.prompt.trim()) throw new Error("multi_agent_prompt_required");
    if (!Number.isInteger(input.config.maxRounds) || input.config.maxRounds < 1 || input.config.maxRounds > 20) throw new Error("multi_agent_rounds_invalid");
    const snapshots = this.db.query<{ agent_id: string; execution_eligible: number; snapshot_json: string }, [string]>("SELECT agent_id, execution_eligible, snapshot_json FROM session_agents WHERE session_id = ? ORDER BY position").all(input.sessionId).filter(item=>!input.config.allowedAgentIds || input.config.allowedAgentIds.includes(item.agent_id));
    const ids = new Set(snapshots.map((item) => item.agent_id));
    if (input.config.speakingOrder.length < (frozenRoute||session.strategy==="team"?1:2) || new Set(input.config.speakingOrder).size !== input.config.speakingOrder.length || input.config.speakingOrder.some((id) => !ids.has(id))) throw new Error("multi_agent_order_invalid");
    if (!ids.has(input.config.synthesizerId)) throw new Error("multi_agent_synthesizer_invalid");
    if (!snapshots.some((item) => item.agent_id === input.config.executionAgentId && item.execution_eligible === 1)) throw new Error("multi_agent_executor_invalid");
    for (const [agentId, effort] of Object.entries(input.config.effortByAgent ?? {})) {
      const snapshot = snapshots.find((item) => item.agent_id === agentId);
      const profile = snapshot ? JSON.parse(snapshot.snapshot_json) as Record<string, any> : null;
      const supported = profile?.modelCapabilities?.reasoningEfforts;
      if (!snapshot || !Array.isArray(supported) || !supported.includes(effort)) throw new Error("multi_agent_effort_unsupported");
    }
    for (const [agentId, fallback] of Object.entries(input.config.fallbackOrderByAgent ?? {})) {
      if (!ids.has(agentId) || !Array.isArray(fallback) || new Set(fallback).size !== fallback.length || fallback.some((id) => id === agentId || !ids.has(id))) throw new Error("multi_agent_fallback_invalid");
    }
    if (input.config.targetAgentIds?.some((id) => !ids.has(id))) throw new Error("multi_agent_target_invalid");
    const id = input.config.clientRequestId
      ? `team-${createHash("sha256").update(`${input.sessionId}:${input.config.clientRequestId}`).digest("hex").slice(0, 32)}`
      : crypto.randomUUID();
    const previous = this.get(id);
    if (previous) {
      if (previous.prompt !== input.prompt.trim() || JSON.stringify({ ...previous.config, contextMessageCursor: undefined, memberProfiles: undefined, pendingRevision: undefined }) !== JSON.stringify({ ...input.config, contextMessageCursor: undefined, memberProfiles: undefined, pendingRevision: undefined })) throw new Error("client_request_id_conflict");
      return previous;
    }
    const attemptId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const now = new Date().toISOString();
    const frozenConfig = { ...input.config, memberProfiles: Object.fromEntries(snapshots.map((s) => [s.agent_id, input.config.routeDecisionId ? input.config.memberProfiles?.[s.agent_id] ?? JSON.parse(s.snapshot_json) : JSON.parse(s.snapshot_json)])), contextMessageCursor: this.db.query<{ cursor: number }, [string]>("SELECT COALESCE(MAX(rowid), 0) AS cursor FROM session_messages WHERE session_id = ?").get(input.sessionId)?.cursor ?? 0 };
    const projection: MultiTaskCreateProjection = {
      id, attemptId, sessionId: input.sessionId, prompt: input.prompt.trim(), config: frozenConfig, createdAt: now,
    };
    const projectTask = () => this.projectCreate(projection);
    if (this.history) {
      await this.history.appendMessage({
        messageId, roomId: input.sessionId, threadId: `thread:${input.sessionId}`,
        runId: id, turnId: null, agentId: null, role: "user", kind: "text",
        content: input.prompt.trim(), parts: [{ type: "text", text: input.prompt.trim() }],
        status: "completed", idempotencyKey: `multi-task-user:${id}`, createdAt: now,
        projectionIntent: { type: "multi_task.create", payload: projection as unknown as Record<string, unknown> },
      }, projectTask);
    } else {
      this.db.transaction(() => {
        projectTask();
        this.db.query("INSERT INTO session_messages (id, session_id, run_id, role, content, status, created_at) VALUES (?, ?, ?, 'user', ?, 'completed', ?)").run(messageId, input.sessionId, id, input.prompt.trim(), now);
        this.db.query("INSERT INTO message_parts (id, message_id, ordinal, type, text) VALUES (?, ?, 0, 'text', ?)").run(crypto.randomUUID(), messageId, input.prompt.trim());
      })();
    }
    return this.get(id)!;
  }

  private projectCreate(input: MultiTaskCreateProjection): void {
    const existing = this.db.query<TaskRow, [string]>("SELECT * FROM multi_tasks WHERE id = ?").get(input.id);
    if (existing) {
      if (existing.session_id !== input.sessionId || existing.prompt !== input.prompt
        || JSON.stringify({ ...JSON.parse(existing.config_json) as MultiTaskConfig, pendingRevision: undefined }) !== JSON.stringify({ ...input.config, pendingRevision: undefined }) || existing.execution_agent_id !== input.config.executionAgentId) {
        throw new Error("multi_task_projection_conflict");
      }
    } else {
      this.db.query(`INSERT INTO multi_tasks
        (id, session_id, prompt, state, attempt_no, config_json, execution_agent_id, created_at, updated_at)
        VALUES (?, ?, ?, 'preparing', 1, ?, ?, ?, ?)`)
        .run(input.id, input.sessionId, input.prompt, JSON.stringify(input.config), input.config.executionAgentId,
          input.createdAt, input.createdAt);
    }
    const attempt = this.db.query<{ id: string; task_id: string }, [string]>(
      "SELECT id, task_id FROM multi_task_attempts WHERE id = ?",
    ).get(input.attemptId);
    if (attempt) {
      if (attempt.task_id !== input.id) throw new Error("multi_task_attempt_projection_conflict");
    } else {
      this.db.query("INSERT INTO multi_task_attempts (id, task_id, attempt_no, status, started_at) VALUES (?, ?, 1, 'active', ?)")
        .run(input.attemptId, input.id, input.createdAt);
    }
    this.db.query("UPDATE sessions SET status = 'preparing', updated_at = ? WHERE id = ?")
      .run(input.createdAt, input.sessionId);
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
    return this.db.transaction(() => {
      this.applyTransition(id, event);
      return this.get(id)!;
    }).immediate();
  }

  setPendingRevision(id: string, pendingRevision: MultiTaskConfig["pendingRevision"] | null): void {
    const task = this.get(id); if (!task) throw new Error("multi_task_not_found");
    const config = { ...task.config };
    if (pendingRevision) config.pendingRevision = pendingRevision; else delete config.pendingRevision;
    this.db.query("UPDATE multi_tasks SET config_json=?,updated_at=? WHERE id=?").run(JSON.stringify(config), new Date().toISOString(), id);
  }

  resumeNewAttempt(id: string, options: { allowOutcomeUnknown?: boolean } = {}): MultiTaskRecord {
    assertTaskWorkflowCompatible(this.db,id);
    return this.db.transaction(() => {
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
      return this.get(id)!;
    }).immediate();
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

  completedTurnAtPosition(input: { taskId: string; phase: string; round: number; participantIndex: number }): { id: string; agentId: string; content: string; usage: unknown } | null {
    const row = this.db.query<{ id: string; agent_id: string; content: string; usage_json: string | null }, [string, string, number, number]>(`
      SELECT id, agent_id, content, usage_json FROM multi_turns
      WHERE task_id = ? AND phase = ? AND round = ? AND participant_index = ?
        AND status = 'completed' AND content IS NOT NULL
      ORDER BY completed_at DESC LIMIT 1
    `).get(input.taskId, input.phase, input.round, input.participantIndex);
    return row ? { id: row.id, agentId: row.agent_id, content: row.content, usage: row.usage_json ? JSON.parse(row.usage_json) : null } : null;
  }

  hasOutcomeUnknown(taskId: string): boolean {
    return this.db.query<{ present: number }, [string]>("SELECT EXISTS(SELECT 1 FROM multi_turns WHERE task_id = ? AND outcome_certainty = 'unknown') AS present").get(taskId)?.present === 1;
  }

  completeTurn(id: string, content: string, usage: unknown): void {
    const turn = this.db.query<{ task_id: string; agent_id: string }, [string]>("SELECT task_id, agent_id FROM multi_turns WHERE id = ?").get(id);
    const changed = this.db.query("UPDATE multi_turns SET status = 'completed', content = ?, usage_json = ?, completed_at = ? WHERE id = ? AND status = 'running'")
      .run(content, usage ? JSON.stringify(usage) : null, new Date().toISOString(), id).changes;
    if (changed === 1 && turn) {
      const task = this.get(turn.task_id)!;
      const effort = task.config.effortByAgent?.[turn.agent_id] as ReasoningEffort | undefined;
      this.usage.record({ stableKey: `multi-turn:${id}`, sessionId: task.sessionId, taskId: task.id, turnId: id, agentId: turn.agent_id, usage: normalizeTokenUsage(usage as TokenUsage | null, effort ?? null) });
    }
  }

  usageSummaries(taskId: string) { return this.usage.summaries(taskId); }

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

  private validatePlan(taskId: string, content: StructuredPlan): void {
    if (validateStructuredPlan(content).length) throw new Error("structured_plan_invalid");
    const task = this.get(taskId);
    if (!task) throw new Error("multi_task_not_found");
    if (task.config.teamExecution && !content.workPackages) throw new Error("team_work_packages_required");
    const executors = content.workPackages?.map((item) => item.executorAgentId) ?? [task.executionAgentId ?? task.config.executionAgentId];
    for (const agentId of executors) {
      const member = this.db.query<{ snapshot_json: string }, [string, string]>("SELECT snapshot_json FROM session_agents WHERE session_id = ? AND agent_id = ?").get(task.sessionId, agentId);
      const snapshot = task.config.memberProfiles?.[agentId] ?? (member ? JSON.parse(member.snapshot_json) as Record<string, unknown> : undefined);
      if ((snapshot?.modelCapabilities as { toolCalling?: boolean } | undefined)?.toolCalling === false) throw new Error("execution_agent_tools_unavailable");
    }
    if (content.workPackages) {
      const ids = this.db.query<{ agent_id: string }, [string]>("SELECT agent_id FROM session_agents WHERE session_id = ?").all(task.sessionId).map((m) => m.agent_id).filter(id=>!task.config.allowedAgentIds || task.config.allowedAgentIds.includes(id));
      const errors = validateWorkPackages(content.workPackages, ids);
      if (task.config.routeDecisionId && content.workPackages.some(p=>p.reviewerAgentId!==(task.config.routingReviewerId ?? null))) errors.push("work_package_reviewer_outside_route");
      if (task.config.targetAgentIds?.length && content.workPackages.some((p) => !task.config.targetAgentIds!.includes(p.executorAgentId))) errors.push("work_package_executor_outside_targets");
      if (errors.length) throw new Error(errors[0]);
      new WorkPackageStore(this.db).validateDefinitions(taskId, content.workPackages);
    } else {
      const eligible = this.db.query<{ execution_eligible: number }, [string, string]>("SELECT execution_eligible FROM session_agents WHERE session_id = ? AND agent_id = ?").get(task.sessionId, task.executionAgentId ?? task.config.executionAgentId);
      if (!eligible?.execution_eligible) throw new Error("execution_agent_not_eligible");
    }
  }

  private savePlan(input: { taskId: string; content: StructuredPlan; createdBy: string; parentVersion?: number | null }, contentHash: string, evidenceHash: string): PlanVersionRecord {
    this.validatePlan(input.taskId, input.content);
    const version = this.db.query<{ next: number }, [string]>("SELECT COALESCE(MAX(version), 0) + 1 AS next FROM plan_versions WHERE task_id = ?").get(input.taskId)!.next;
    const id = crypto.randomUUID();
    this.db.query("UPDATE plan_versions SET status = 'superseded' WHERE task_id = ? AND status = 'pending'").run(input.taskId);
    this.db.query(`INSERT INTO plan_versions
      (id, task_id, version, parent_version, content_json, content_hash, evidence_hash, created_by, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(id, input.taskId, version, input.parentVersion ?? null, JSON.stringify(input.content), contentHash, evidenceHash, input.createdBy, new Date().toISOString());
    if (input.content.workPackages) new WorkPackageStore(this.db).replacePlan(input.taskId, version, input.content.workPackages);
    return this.getPlan(input.taskId, version)!;
  }

  async addPlan(input: { taskId: string; content: StructuredPlan; createdBy: string; parentVersion?: number | null }): Promise<PlanVersionRecord> {
    assertTaskWorkflowCompatible(this.db,input.taskId);
    this.validatePlan(input.taskId, input.content);
    const contentHash = await hashStructuredPlan(input.content);
    const evidenceHash = await hashStructuredPlan({ ...input.content, objective: "evidence", summary: "evidence", steps: [] });
    return this.db.transaction(() => this.savePlan(input, contentHash, evidenceHash)).immediate();
  }

  async editAndApprovePlan(input: { taskId: string; version: number; hash: string; content: StructuredPlan; clientDecisionKey: string; reason?: string }): Promise<{ plan: PlanVersionRecord; decision: { id: string; decision: string; replayed: boolean } }> {
    assertTaskWorkflowCompatible(this.db,input.taskId);
    if (validateStructuredPlan(input.content).length) throw new Error("structured_plan_invalid");
    // Hash outside SQLite; after awaiting, recheck both the approval revision
    // and every member/assignment inside one synchronous transaction. These
    // tables have no HistoryStore projection, so no journal append is split off.
    const contentHash = await hashStructuredPlan(input.content);
    const evidenceHash = await hashStructuredPlan({ ...input.content, objective: "evidence", summary: "evidence", steps: [] });
    return this.db.transaction(() => {
      const duplicate = this.db.query<{ id: string; task_id: string; plan_version: number; plan_hash: string; decision: string }, [string]>("SELECT id, task_id, plan_version, plan_hash, decision FROM plan_decisions WHERE client_decision_key = ?").get(input.clientDecisionKey);
      if (duplicate) {
        const plan = this.getPlan(input.taskId, duplicate.plan_version);
        const parent = this.getPlan(input.taskId, input.version);
        if (duplicate.task_id !== input.taskId || duplicate.decision !== "approve_exact_plan" || duplicate.plan_hash !== contentHash || plan?.parentVersion !== input.version || parent?.contentHash !== input.hash) throw new Error("plan_decision_key_conflict");
        return { plan, decision: { id: duplicate.id, decision: duplicate.decision, replayed: true } };
      }
      const previous = this.getPlan(input.taskId);
      if (!previous || previous.version !== input.version || previous.contentHash !== input.hash || previous.status !== "pending") throw new Error("plan_hash_mismatch");
      if (this.get(input.taskId)?.state !== "awaiting_plan_approval") throw new Error("plan_not_awaiting_approval");
      this.validatePlan(input.taskId, input.content);
      this.applyTransition(input.taskId, { type: "edit_plan" });
      const plan = this.savePlan({ taskId: input.taskId, content: input.content, createdBy: "user", parentVersion: input.version }, contentHash, evidenceHash);
      this.applyTransition(input.taskId, { type: "edited_plan_ready" });
      const decision = this.decidePlan({ taskId: input.taskId, version: plan.version, hash: plan.contentHash,
        decision: "approve_exact_plan", clientDecisionKey: input.clientDecisionKey, reason: input.reason });
      return { plan: this.getPlan(input.taskId, plan.version)!, decision };
    }).immediate();
  }

  getPlan(taskId: string, version?: number): PlanVersionRecord | null {
    const row = version === undefined
      ? this.db.query<any, [string]>("SELECT * FROM plan_versions WHERE task_id = ? ORDER BY version DESC LIMIT 1").get(taskId)
      : this.db.query<any, [string, number]>("SELECT * FROM plan_versions WHERE task_id = ? AND version = ?").get(taskId, version);
    return row ? { id: row.id, taskId: row.task_id, version: row.version, parentVersion: row.parent_version, content: JSON.parse(row.content_json), contentHash: row.content_hash, evidenceHash: row.evidence_hash, createdBy: row.created_by, status: row.status, createdAt: row.created_at } : null;
  }

  decidePlan(input: { taskId: string; version: number; hash: string; clientDecisionKey: string; decision: "approve_exact_plan" | "request_replan" | "reject"; reason?: string }): { id: string; decision: string; replayed: boolean } {
    assertTaskWorkflowCompatible(this.db,input.taskId);
    return this.db.transaction(() => {
      const duplicate = this.db.query<{ id: string; task_id: string; plan_hash: string; decision: string }, [string]>("SELECT id, task_id, plan_hash, decision FROM plan_decisions WHERE client_decision_key = ?").get(input.clientDecisionKey);
      if (duplicate) {
        if (duplicate.task_id !== input.taskId || duplicate.plan_hash !== input.hash || duplicate.decision !== input.decision) throw new Error("plan_decision_key_conflict");
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
      return { id, decision: input.decision, replayed: false };
    }).immediate();
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
