import type { Database } from "bun:sqlite";
import {
  buildDiscussionMessages,
  buildTurnSystem,
  validateStructuredPlan,
  normalizeCollaborationSettings,
  type ModelGateway,
  type OrchestrationAgent,
  type RoomCollaborationSettings,
  type StructuredPlan,
  type TokenUsage,
} from "@socrates/core";
import type { EventStore } from "../store/event-store";
import { MultiTaskStore, type MultiTaskConfig } from "./task-store";
import { ContextCompactionService } from "../services/context-compaction";
import type { HistoryStore } from "../store/history-store";

export type MultiAgentEvent =
  | { type: "task_state"; taskId: string; state: string }
  | { type: "turn_started"; taskId: string; agentId: string; nickname: string; model: string; round: number; phase: "discussing" | "synthesizing" }
  | { type: "delta"; taskId: string; agentId: string; text: string }
  | { type: "turn_completed"; taskId: string; agentId: string; nickname: string; model: string; round: number; phase: "discussing" | "synthesizing"; content: string; usage?: TokenUsage; replayed?: boolean }
  | { type: "plan_ready"; taskId: string; plan: unknown }
  | { type: "reviewer_verdict"; taskId: string; reviewerId: string; nickname: string; verdict: "approve" | "request_changes"; notes: string; requestedRevision: boolean }
  | { type: "agent_fallback_selected"; taskId: string; originalAgentId: string; fallbackAgentId: string; nickname: string; model: string; round: number }
  | { type: "task_failed" | "task_cancelled"; taskId: string; message?: string };

type SnapshotRow = { agent_id: string; snapshot_json: string; position: number };

function parsePlan(text: string): StructuredPlan | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  try {
    const value = JSON.parse(stripped);
    return validateStructuredPlan(value).length ? null : value as StructuredPlan;
  } catch {
    return null;
  }
}

const PLAN_SYSTEM = `You synthesize a coding discussion into one reviewable execution plan. Return JSON only with this exact shape:
{"objective":"...","summary":"...","steps":[{"id":"1","title":"...","description":"...","files":["relative/path"],"commands":["command"],"risks":["..."],"verification":["..."]}],"evidence":[{"refId":"opaque-id","snapshotHash":"sha256"}]}
Never execute tools. Paths must be workspace-relative. An empty evidence array is valid.`;

const REVIEW_SYSTEM = `You are the designated reviewer for an execution plan. Judge whether it is safe and complete enough to execute. Return JSON only:
{"verdict":"approve"|"request_changes","notes":"one paragraph; if request_changes, say exactly what to fix"}
Approve a sound plan. Request changes only for real gaps (missing steps, unsafe commands, wrong files). Never execute tools.`;

/** 宽松解析 reviewer 裁决；解析不出时按 approve 处理，避免因格式问题卡死流程（人工仍会最终确认）。 */
function parseVerdict(text: string): { verdict: "approve" | "request_changes"; notes: string } {
  const stripped = text.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  try {
    const value = JSON.parse(stripped) as Record<string, unknown>;
    const verdict = value.verdict === "request_changes" ? "request_changes" : "approve";
    return { verdict, notes: typeof value.notes === "string" ? value.notes : "" };
  } catch {
    return { verdict: "approve", notes: text.slice(0, 500) };
  }
}

export class MultiAgentCoordinator {
  private readonly controllers = new Map<string, AbortController>();
  private readonly compaction: ContextCompactionService;

  constructor(
    private readonly db: Database,
    private readonly store: MultiTaskStore,
    private readonly events: EventStore,
    private readonly gateway: ModelGateway,
    private readonly resolveAgent: (agentId: string, snapshot: Record<string, unknown>) => OrchestrationAgent,
    private readonly history?: HistoryStore,
  ) { this.compaction = new ContextCompactionService(db); }

  async create(input: { sessionId: string; prompt: string; config: MultiTaskConfig }) {
    return this.store.create(input);
  }

  async run(taskId: string, emit: (event: MultiAgentEvent) => void | Promise<void> = () => {}): Promise<void> {
    if (this.controllers.has(taskId)) throw new Error("multi_task_already_running");
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    try {
      const task = this.store.get(taskId);
      if (!task || !["preparing", "discussing", "synthesizing"].includes(task.state)) throw new Error("multi_task_not_runnable");
      const snapshots = this.snapshots(task.sessionId);
      const byId = new Map(snapshots.map((item) => [item.agentId, item]));
      if (task.state === "preparing") {
        this.store.transition(taskId, { type: "prepared_multi" });
        await this.stateEvent(taskId, task.sessionId, "discussing", emit);
      }
      const collabRow = this.db.query<{ collaboration_json: string | null }, [string]>("SELECT collaboration_json FROM sessions WHERE id = ?").get(task.sessionId);
      const rawCollaboration = collabRow?.collaboration_json
        ? JSON.parse(collabRow.collaboration_json) as unknown
        : null;
      const collab = normalizeCollaborationSettings(rawCollaboration);
      const completed: Array<{ agentId: string; agentName: string; round: number; content: string }> = [];
      let ordinal = 0;
      const legacyUnconfigured = !collabRow?.collaboration_json;
      const legacyShape = rawCollaboration !== null
        && typeof rawCollaboration === "object"
        && !("discussion" in rawCollaboration);
      const discussionEnabled = legacyUnconfigured || collab.discussion.enabled;
      const discussionRounds = discussionEnabled
        ? legacyUnconfigured || legacyShape ? task.config.maxRounds : collab.discussion.maxRounds
        : 0;
      const speakingOrder = discussionEnabled && !legacyShape && collab.discussion.speakerOrder.length
        ? collab.discussion.speakerOrder
        : task.config.speakingOrder;
      for (let round = 1; round <= discussionRounds; round += 1) {
        for (const agentId of speakingOrder) {
          if (controller.signal.aborted) throw new Error("multi_task_cancelled");
          const prior = this.store.completedTurnAtPosition({ taskId, phase: "discussing", round, participantIndex: ordinal });
          if (prior) {
            const priorParticipant = byId.get(prior.agentId);
            if (!priorParticipant) throw new Error("multi_participant_snapshot_missing");
            const priorAgent = this.resolveAgent(prior.agentId, priorParticipant.snapshot);
            completed.push({ agentId: prior.agentId, agentName: priorAgent.nickname, round, content: prior.content });
            await emit({ type: "turn_completed", taskId, agentId: prior.agentId, nickname: priorAgent.nickname, model: priorAgent.modelId, round, phase: "discussing", content: prior.content, usage: prior.usage as TokenUsage | undefined, replayed: true });
            ordinal += 1;
            continue;
          }
          const participant = byId.get(agentId);
          if (!participant) throw new Error("multi_participant_snapshot_missing");
          const resolved = this.resolveAgent(agentId, participant.snapshot);
          let actualAgent = { ...resolved, reasoningEffort: task.config.effortByAgent?.[agentId] as OrchestrationAgent["reasoningEffort"] ?? resolved.reasoningEffort };
          let actualAgentId = agentId;
          if (task.state === "synthesizing") throw new Error("multi_discussion_checkpoint_incomplete");
          const stableKey = `${task.id}:${task.attemptNo}:discussing:${round}:${ordinal}`;
          const persisted = this.store.beginTurn({ taskId, stableKey, phase: "discussing", round, participantIndex: ordinal, agentId, snapshot: participant.snapshot });
          if (persisted.status === "completed" && persisted.content !== null) {
            completed.push({ agentId, agentName: actualAgent.nickname, round, content: persisted.content });
            await emit({ type: "turn_completed", taskId, agentId, nickname: actualAgent.nickname, model: actualAgent.modelId, round, phase: "discussing", content: persisted.content, replayed: true });
            ordinal += 1;
            continue;
          }
          if (persisted.status !== "running" || persisted.outcomeCertainty === "unknown") throw new Error("multi_turn_outcome_unknown");
          await emit({ type: "turn_started", taskId, agentId, nickname: actualAgent.nickname, model: actualAgent.modelId, round, phase: "discussing" });
          const context = this.compaction.compact(taskId, completed);
          if (context.created) this.events.append({ eventId: `multi-compaction:${taskId}:${context.sourceHash}`, sessionId: task.sessionId, taskId, type: "multi.context_compacted", payload: { sourceHash: context.sourceHash, coveredFrom: context.coveredFrom, coveredTo: context.coveredTo } });
          let activeTurn = persisted;
          let result = await this.callAgent(actualAgent, buildTurnSystem(actualAgent, { duty: "discuss", round }, task.config.maxRounds), buildDiscussionMessages(task.prompt, context.turns), controller.signal, async (text) => emit({ type: "delta", taskId, agentId: actualAgentId, text }));
          if (result.error && !result.receivedDelta && result.error !== "multi_task_cancelled") {
            this.store.failTurn(activeTurn.id, result.error);
            for (const fallbackId of task.config.fallbackOrderByAgent?.[agentId] ?? []) {
              const fallbackParticipant = byId.get(fallbackId);
              if (!fallbackParticipant) continue;
              const fallbackResolved = this.resolveAgent(fallbackId, fallbackParticipant.snapshot);
              actualAgent = { ...fallbackResolved, reasoningEffort: task.config.effortByAgent?.[fallbackId] as OrchestrationAgent["reasoningEffort"] ?? fallbackResolved.reasoningEffort };
              actualAgentId = fallbackId;
              this.events.append({ eventId: `multi-fallback:${taskId}:${task.attemptNo}:${round}:${ordinal}:${fallbackId}`, sessionId: task.sessionId, taskId, type: "multi.agent_fallback_selected", payload: { originalAgentId: agentId, fallbackAgentId: fallbackId, nickname: actualAgent.nickname, model: actualAgent.modelId, round } });
              await emit({ type: "agent_fallback_selected", taskId, originalAgentId: agentId, fallbackAgentId: fallbackId, nickname: actualAgent.nickname, model: actualAgent.modelId, round });
              activeTurn = this.store.beginTurn({ taskId, stableKey: `${stableKey}:fallback:${fallbackId}`, phase: "discussing", round, participantIndex: ordinal, agentId: fallbackId, snapshot: fallbackParticipant.snapshot });
              result = await this.callAgent(actualAgent, buildTurnSystem(actualAgent, { duty: "discuss", round }, task.config.maxRounds), buildDiscussionMessages(task.prompt, context.turns), controller.signal, async (text) => emit({ type: "delta", taskId, agentId: fallbackId, text }));
              if (!result.error) break;
              this.store.failTurn(activeTurn.id, result.error, result.receivedDelta || result.error === "provider_outcome_unknown" ? "unknown" : "known");
              if (result.receivedDelta || result.error === "provider_outcome_unknown") break;
            }
          }
          if (result.error) {
            this.store.failTurn(activeTurn.id, result.error, result.receivedDelta || result.error === "provider_outcome_unknown" ? "unknown" : "known");
            throw new Error(result.error);
          }
          this.store.completeTurn(activeTurn.id, result.content, result.usage);
          completed.push({ agentId: actualAgentId, agentName: actualAgent.nickname, round, content: result.content });
          await this.persistAssistantMessage(task.sessionId, actualAgentId, result.content);
          await emit({ type: "turn_completed", taskId, agentId: actualAgentId, nickname: actualAgent.nickname, model: actualAgent.modelId, round, phase: "discussing", content: result.content, usage: result.usage });
          this.store.transition(taskId, { type: "next_turn" });
          ordinal += 1;
        }
      }
      this.db.query("UPDATE multi_tasks SET discussion_cutoff = ? WHERE id = ?").run(ordinal, taskId);
      if (this.store.get(taskId)?.state === "discussing") {
        this.store.transition(taskId, { type: "discussion_complete" });
        await this.stateEvent(taskId, task.sessionId, "synthesizing", emit);
      }
      this.assertLegacyBossExecutionAllowed(task.config, rawCollaboration);
      const synthesizerId = this.effectiveSynthesizerId(task.config, collab);
      let plan = await this.synthesize(taskId, synthesizerId, ordinal, completed, null, controller.signal, emit);
      this.store.transition(taskId, { type: "plan_ready" });

      // 指定 Reviewer / Executor 自检：真实跑一次审核 Agent，request_changes 自动改一版后交人工确认
      const reviewerId = this.effectiveReviewerId(task.config, collab);
      if (reviewerId) {
        const verdict = await this.reviewPlan(taskId, reviewerId, plan, ordinal, controller.signal, emit);
        const reviewer = this.resolveAgent(reviewerId, this.snapshots(task.sessionId).find((s) => s.agentId === reviewerId)!.snapshot);
        const requestedRevision = verdict.verdict === "request_changes";
        await emit({ type: "reviewer_verdict", taskId, reviewerId, nickname: reviewer.nickname, verdict: verdict.verdict, notes: verdict.notes, requestedRevision });
        if (requestedRevision) {
          // ponytail: 只自动改一轮，避免 reviewer↔synthesizer 死循环；要多轮再加
          this.store.transition(taskId, { type: "request_replan" });
          this.store.transition(taskId, { type: "synthesize_revision" });
          const revisionTurns = completed.concat([{ agentId: reviewerId, agentName: reviewer.nickname, round: task.config.maxRounds + 1, content: `Reviewer requested changes: ${verdict.notes}` }]);
          plan = await this.synthesize(taskId, synthesizerId, ordinal + completed.length + 4, revisionTurns, plan.version, controller.signal, emit);
          this.store.transition(taskId, { type: "plan_ready" });
        }
      }

      await this.stateEvent(taskId, task.sessionId, "awaiting_plan_approval", emit);
      await emit({ type: "plan_ready", taskId, plan });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const task = this.store.get(taskId);
      if (task && !["failed", "cancelled", "completed", "paused", "awaiting_plan_approval"].includes(task.state)) {
        if (message === "multi_task_cancelled") this.store.transition(taskId, { type: "cancel", reason: "user_cancelled" });
        else if (message === "provider_outcome_unknown" || message === "multi_turn_outcome_unknown") this.store.transition(taskId, { type: "pause" });
        else this.store.transition(taskId, { type: "fail", reason: message });
      }
      if (this.store.get(taskId)?.state === "paused") await emit({ type: "task_state", taskId, state: "paused" });
      else await emit(message === "multi_task_cancelled" ? { type: "task_cancelled", taskId } : { type: "task_failed", taskId, message });
    } finally {
      this.controllers.delete(taskId);
    }
  }

  cancel(taskId: string): void {
    const controller = this.controllers.get(taskId);
    if (controller) controller.abort();
    else {
      const task = this.store.get(taskId);
      if (!task) throw new Error("multi_task_not_found");
      if (!["failed", "cancelled", "completed"].includes(task.state)) this.store.transition(taskId, { type: "cancel", reason: "user_cancelled" });
    }
  }

  pause(taskId: string): void {
    const task = this.store.get(taskId);
    if (!task) throw new Error("multi_task_not_found");
    if (!["preparing", "discussing", "synthesizing"].includes(task.state)) throw new Error("multi_task_not_pausable");
    this.store.transition(taskId, { type: "pause" });
    this.controllers.get(taskId)?.abort();
  }

  async resume(taskId: string, emit: (event: MultiAgentEvent) => void | Promise<void> = () => {}): Promise<void> {
    await this.waitUntilStopped(taskId);
    const resumed = this.store.resumeNewAttempt(taskId);
    if (!["preparing", "discussing", "synthesizing"].includes(resumed.state)) throw new Error("multi_task_coordinator_resume_invalid");
    await this.run(taskId, emit);
  }

  async resumeInBackground(taskId: string): Promise<void> {
    await this.waitUntilStopped(taskId);
    const resumed = this.store.resumeNewAttempt(taskId);
    if (!["preparing", "discussing", "synthesizing"].includes(resumed.state)) throw new Error("multi_task_coordinator_resume_invalid");
    void this.run(taskId).catch(() => {});
  }

  async retryAfterReview(taskId: string): Promise<void> {
    await this.waitUntilStopped(taskId);
    const resumed = this.store.resumeNewAttempt(taskId, { allowOutcomeUnknown: true });
    if (!["preparing", "discussing", "synthesizing"].includes(resumed.state)) throw new Error("multi_task_coordinator_resume_invalid");
    void this.run(taskId).catch(() => {});
  }

  private async waitUntilStopped(taskId: string): Promise<void> {
    for (let attempt = 0; this.controllers.has(taskId) && attempt < 200; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (this.controllers.has(taskId)) throw new Error("multi_task_pause_in_progress");
  }

  async replan(taskId: string, instruction: string, emit: (event: MultiAgentEvent) => void | Promise<void> = () => {}): Promise<void> {
    const task = this.store.get(taskId);
    const parent = this.store.getPlan(taskId);
    if (!task || task.state !== "revising_plan" || !parent) throw new Error("multi_task_not_revising");
    const controller = new AbortController();
    try {
      this.store.transition(taskId, { type: "synthesize_revision" });
      await this.stateEvent(taskId, task.sessionId, "synthesizing", emit);
      const turns = this.db.query<{ agent_id: string; snapshot_json: string; round: number; content: string }, [string]>(`
      SELECT agent_id, snapshot_json, round, content FROM multi_turns
      WHERE task_id = ? AND phase = 'discussing' AND status = 'completed' ORDER BY participant_index
      `).all(taskId).map((row) => ({
        agentId: row.agent_id,
        agentName: String((JSON.parse(row.snapshot_json) as Record<string, unknown>).nickname ?? row.agent_id),
        round: row.round,
        content: row.content,
      }));
      turns.push({ agentId: "user", agentName: "User revision", round: task.config.maxRounds + 1, content: instruction });
      const synthesizerId = this.effectiveSynthesizerId(task.config, this.collaborationFor(task.sessionId));
      const plan = await this.synthesize(taskId, synthesizerId, (task.discussionCutoff ?? turns.length) + parent.version * 2, turns, parent.version, controller.signal, emit);
      this.store.transition(taskId, { type: "plan_ready" });
      await this.stateEvent(taskId, task.sessionId, "awaiting_plan_approval", emit);
      await emit({ type: "plan_ready", taskId, plan });
    } catch (error) {
      const current = this.store.get(taskId);
      if (current && !["failed", "cancelled", "completed", "paused"].includes(current.state)) this.store.transition(taskId, { type: "fail", reason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async synthesize(
    taskId: string,
    synthesizerId: string,
    ordinal: number,
    completed: Array<{ agentId: string; agentName: string; round: number; content: string }>,
    parentVersion: number | null,
    signal: AbortSignal,
    emit: (event: MultiAgentEvent) => void | Promise<void>,
  ) {
    const task = this.store.get(taskId)!;
    const participant = this.snapshots(task.sessionId).find((item) => item.agentId === synthesizerId);
    if (!participant) throw new Error("multi_synthesizer_snapshot_missing");
    const resolved = this.resolveAgent(synthesizerId, participant.snapshot);
    const agent = { ...resolved, reasoningEffort: task.config.effortByAgent?.[synthesizerId] as OrchestrationAgent["reasoningEffort"] ?? resolved.reasoningEffort };
    let lastInvalid = "";
    for (let repair = 0; repair < 2; repair += 1) {
      const prior = this.store.completedLogicalTurn({ taskId, phase: "synthesizing", round: 0, participantIndex: ordinal + repair, agentId: synthesizerId });
      if (prior) {
        const parsed = parsePlan(prior.content);
        if (parsed) return this.store.addPlan({ taskId, content: parsed, createdBy: synthesizerId, parentVersion });
        lastInvalid = prior.content;
        continue;
      }
      const stableKey = `${task.id}:${task.attemptNo}:synthesizing:0:${ordinal + repair}`;
      const turn = this.store.beginTurn({ taskId, stableKey, phase: "synthesizing", round: 0, participantIndex: ordinal + repair, agentId: synthesizerId, snapshot: participant.snapshot });
      if (turn.status === "completed" && turn.content) {
        const parsed = parsePlan(turn.content);
        if (parsed) return this.store.addPlan({ taskId, content: parsed, createdBy: synthesizerId, parentVersion });
        lastInvalid = turn.content;
        continue;
      }
      if (turn.status !== "running" || turn.outcomeCertainty === "unknown") throw new Error("multi_turn_outcome_unknown");
      await emit({ type: "turn_started", taskId, agentId: synthesizerId, nickname: agent.nickname, model: agent.modelId, round: 0, phase: "synthesizing" });
      const repairInstruction = repair ? `\n\nYour prior output was invalid. Repair it to the exact JSON schema. Invalid output:\n${lastInvalid.slice(0, 12_000)}` : "";
      const context = this.compaction.compact(taskId, completed);
      if (context.created) this.events.append({ eventId: `multi-compaction:${taskId}:${context.sourceHash}`, sessionId: task.sessionId, taskId, type: "multi.context_compacted", payload: { sourceHash: context.sourceHash, coveredFrom: context.coveredFrom, coveredTo: context.coveredTo } });
      const result = await this.callAgent(agent, `${PLAN_SYSTEM}${repairInstruction}`, buildDiscussionMessages(task.prompt, context.turns), signal, async (text) => emit({ type: "delta", taskId, agentId: synthesizerId, text }));
      if (result.error) { this.store.failTurn(turn.id, result.error, result.receivedDelta || result.error === "provider_outcome_unknown" ? "unknown" : "known"); throw new Error(result.error); }
      this.store.completeTurn(turn.id, result.content, result.usage);
      const parsed = parsePlan(result.content);
      if (parsed) return this.store.addPlan({ taskId, content: parsed, createdBy: synthesizerId, parentVersion });
      lastInvalid = result.content;
    }
    throw new Error("structured_plan_invalid_after_repair");
  }

  private async callAgent(agent: OrchestrationAgent, system: string, messages: ReturnType<typeof buildDiscussionMessages>, signal: AbortSignal, delta: (text: string) => void | Promise<void>) {
    let content = "";
    let usage: TokenUsage | undefined;
    let error: string | undefined;
    let receivedDelta = false;
    try {
      for await (const event of this.gateway({ providerType: agent.providerType, baseUrl: agent.baseUrl, apiKey: agent.apiKey, modelId: agent.modelId, system, temperature: agent.temperature, reasoningEffort: agent.reasoningEffort, messages, signal })) {
        if (event.type === "delta") { receivedDelta = true; content += event.text; await delta(event.text); }
        else if (event.type === "done") usage = event.usage;
        else error = event.message;
      }
    } catch {
      error = signal.aborted ? "multi_task_cancelled" : "provider_outcome_unknown";
    }
    return { content, usage, error, receivedDelta };
  }

  private snapshots(sessionId: string) {
    return this.db.query<SnapshotRow, [string]>("SELECT agent_id, snapshot_json, position FROM session_agents WHERE session_id = ? ORDER BY position").all(sessionId)
      .map((row) => ({ agentId: row.agent_id, snapshot: JSON.parse(row.snapshot_json) as Record<string, unknown>, position: row.position }));
  }

  private async persistAssistantMessage(sessionId: string, agentId: string, content: string): Promise<void> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    if (this.history) {
      await this.history.appendMessage({ messageId: id, roomId: sessionId, threadId: `thread:${sessionId}`,
        runId: null, turnId: null, agentId, role: "assistant", kind: "text", content,
        parts: [{ type: "text", text: content }], status: "completed", idempotencyKey: `multi-assistant:${id}`, createdAt: now });
      return;
    }
    this.db.transaction(() => {
      this.db.query("INSERT INTO session_messages (id, session_id, role, author_id, content, status, created_at) VALUES (?, ?, 'assistant', ?, ?, 'completed', ?)").run(id, sessionId, agentId, content, now);
      this.db.query("INSERT INTO message_parts (id, message_id, ordinal, type, text) VALUES (?, ?, 0, 'text', ?)").run(crypto.randomUUID(), id, content);
    })();
  }

  private collaborationFor(sessionId: string): RoomCollaborationSettings {
    const row = this.db.query<{ collaboration_json: string | null }, [string]>("SELECT collaboration_json FROM sessions WHERE id = ?").get(sessionId);
    return normalizeCollaborationSettings(row?.collaboration_json ? JSON.parse(row.collaboration_json) : null);
  }

  private effectiveSynthesizerId(config: MultiTaskConfig, collab: RoomCollaborationSettings): string {
    if (collab.discussion.enabled && collab.discussion.summaryAgentId) {
      return collab.discussion.summaryAgentId;
    }
    if (collab.strategy === "team" && collab.assignment.coordinatorAgentId) {
      return collab.assignment.coordinatorAgentId;
    }
    return config.synthesizerId;
  }

  private effectiveReviewerId(config: MultiTaskConfig, collab: RoomCollaborationSettings): string | null {
    if (collab.planConfirmation.mode === "coordinator") {
      return collab.assignment.coordinatorAgentId ?? config.synthesizerId;
    }
    if (collab.planConfirmation.mode === "reviewer") {
      return collab.planConfirmation.reviewerAgentId;
    }
    return null;
  }

  private assertLegacyBossExecutionAllowed(
    config: MultiTaskConfig,
    raw: unknown,
  ): void {
    const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const boss = record.boss && typeof record.boss === "object"
      ? record.boss as Record<string, unknown>
      : {};
    if (
      boss.enabled === true
      && boss.allowBossExecution !== true
      && boss.bossAgentId === config.executionAgentId
    ) {
      throw new Error("boss_must_not_execute");
    }
  }

  /** 审核一版计划，返回裁决。与讨论/综合共用一套幂等的 turn 机制，resume 可回放。 */
  private async reviewPlan(
    taskId: string,
    reviewerId: string,
    plan: { content: StructuredPlan },
    ordinal: number,
    signal: AbortSignal,
    emit: (event: MultiAgentEvent) => void | Promise<void>,
  ): Promise<{ verdict: "approve" | "request_changes"; notes: string }> {
    const task = this.store.get(taskId)!;
    const participant = this.snapshots(task.sessionId).find((item) => item.agentId === reviewerId);
    if (!participant) throw new Error("multi_reviewer_snapshot_missing");
    const index = ordinal + 3;
    const prior = this.store.completedLogicalTurn({ taskId, phase: "reviewing", round: 0, participantIndex: index, agentId: reviewerId });
    if (prior) return parseVerdict(prior.content);
    const agent = { ...this.resolveAgent(reviewerId, participant.snapshot), reasoningEffort: task.config.effortByAgent?.[reviewerId] as OrchestrationAgent["reasoningEffort"] ?? undefined };
    const stableKey = `${task.id}:${task.attemptNo}:reviewing:0:${index}`;
    const turn = this.store.beginTurn({ taskId, stableKey, phase: "reviewing", round: 0, participantIndex: index, agentId: reviewerId, snapshot: participant.snapshot });
    if (turn.status === "completed" && turn.content) return parseVerdict(turn.content);
    if (turn.status !== "running" || turn.outcomeCertainty === "unknown") throw new Error("multi_turn_outcome_unknown");
    await emit({ type: "turn_started", taskId, agentId: reviewerId, nickname: agent.nickname, model: agent.modelId, round: 0, phase: "synthesizing" });
    const messages = buildDiscussionMessages(`${task.prompt}\n\nPlan under review:\n${JSON.stringify(plan.content)}`, []);
    const result = await this.callAgent(agent, REVIEW_SYSTEM, messages, signal, async (text) => emit({ type: "delta", taskId, agentId: reviewerId, text }));
    if (result.error) { this.store.failTurn(turn.id, result.error, result.receivedDelta || result.error === "provider_outcome_unknown" ? "unknown" : "known"); throw new Error(result.error); }
    this.store.completeTurn(turn.id, result.content, result.usage);
    return parseVerdict(result.content);
  }

  private async stateEvent(taskId: string, sessionId: string, state: string, emit: (event: MultiAgentEvent) => void | Promise<void>) {
    this.events.append({ eventId: `multi-state:${taskId}:${state}:${crypto.randomUUID()}`, sessionId, taskId, type: "multi.state", payload: { state } });
    await emit({ type: "task_state", taskId, state });
  }
}
