import type { Database } from "bun:sqlite";
import {
  buildDiscussionMessages,
  buildTurnSystem,
  validateStructuredPlan,
  type ModelGateway,
  type OrchestrationAgent,
  type StructuredPlan,
  type TokenUsage,
} from "@socrates/core";
import type { EventStore } from "../store/event-store";
import { MultiTaskStore, type MultiTaskConfig } from "./task-store";

export type MultiAgentEvent =
  | { type: "task_state"; taskId: string; state: string }
  | { type: "turn_started"; taskId: string; agentId: string; nickname: string; model: string; round: number; phase: "discussing" | "synthesizing" }
  | { type: "delta"; taskId: string; agentId: string; text: string }
  | { type: "turn_completed"; taskId: string; agentId: string; nickname: string; model: string; round: number; phase: "discussing" | "synthesizing"; content: string; usage?: TokenUsage; replayed?: boolean }
  | { type: "plan_ready"; taskId: string; plan: unknown }
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

export class MultiAgentCoordinator {
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly db: Database,
    private readonly store: MultiTaskStore,
    private readonly events: EventStore,
    private readonly gateway: ModelGateway,
    private readonly resolveAgent: (agentId: string, snapshot: Record<string, unknown>) => OrchestrationAgent,
  ) {}

  create(input: { sessionId: string; prompt: string; config: MultiTaskConfig }) {
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
      const completed: Array<{ agentId: string; agentName: string; round: number; content: string }> = [];
      let ordinal = 0;
      for (let round = 1; round <= task.config.maxRounds; round += 1) {
        for (const agentId of task.config.speakingOrder) {
          if (controller.signal.aborted) throw new Error("multi_task_cancelled");
          const participant = byId.get(agentId);
          if (!participant) throw new Error("multi_participant_snapshot_missing");
          const agent = this.resolveAgent(agentId, participant.snapshot);
          const prior = this.store.completedLogicalTurn({ taskId, phase: "discussing", round, participantIndex: ordinal, agentId });
          if (prior) {
            completed.push({ agentId, agentName: agent.nickname, round, content: prior.content });
            await emit({ type: "turn_completed", taskId, agentId, nickname: agent.nickname, model: agent.modelId, round, phase: "discussing", content: prior.content, usage: prior.usage as TokenUsage | undefined, replayed: true });
            ordinal += 1;
            continue;
          }
          if (task.state === "synthesizing") throw new Error("multi_discussion_checkpoint_incomplete");
          const stableKey = `${task.id}:${task.attemptNo}:discussing:${round}:${ordinal}`;
          const persisted = this.store.beginTurn({ taskId, stableKey, phase: "discussing", round, participantIndex: ordinal, agentId, snapshot: participant.snapshot });
          if (persisted.status === "completed" && persisted.content !== null) {
            completed.push({ agentId, agentName: agent.nickname, round, content: persisted.content });
            await emit({ type: "turn_completed", taskId, agentId, nickname: agent.nickname, model: agent.modelId, round, phase: "discussing", content: persisted.content, replayed: true });
            ordinal += 1;
            continue;
          }
          if (persisted.status !== "running" || persisted.outcomeCertainty === "unknown") throw new Error("multi_turn_outcome_unknown");
          await emit({ type: "turn_started", taskId, agentId, nickname: agent.nickname, model: agent.modelId, round, phase: "discussing" });
          const result = await this.callAgent(agent, buildTurnSystem(agent, { duty: "discuss", round }, task.config.maxRounds), buildDiscussionMessages(task.prompt, completed), controller.signal, async (text) => emit({ type: "delta", taskId, agentId, text }));
          if (result.error) {
            this.store.failTurn(persisted.id, result.error, result.error === "provider_outcome_unknown" ? "unknown" : "known");
            throw new Error(result.error);
          }
          this.store.completeTurn(persisted.id, result.content, result.usage);
          completed.push({ agentId, agentName: agent.nickname, round, content: result.content });
          this.persistAssistantMessage(task.sessionId, agentId, result.content);
          await emit({ type: "turn_completed", taskId, agentId, nickname: agent.nickname, model: agent.modelId, round, phase: "discussing", content: result.content, usage: result.usage });
          this.store.transition(taskId, { type: "next_turn" });
          ordinal += 1;
        }
      }
      this.db.query("UPDATE multi_tasks SET discussion_cutoff = ? WHERE id = ?").run(ordinal, taskId);
      if (this.store.get(taskId)?.state === "discussing") {
        this.store.transition(taskId, { type: "discussion_complete" });
        await this.stateEvent(taskId, task.sessionId, "synthesizing", emit);
      }
      const plan = await this.synthesize(taskId, task.config.synthesizerId, ordinal, completed, null, controller.signal, emit);
      this.store.transition(taskId, { type: "plan_ready" });
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
      const plan = await this.synthesize(taskId, task.config.synthesizerId, (task.discussionCutoff ?? turns.length) + parent.version * 2, turns, parent.version, controller.signal, emit);
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
    const agent = this.resolveAgent(synthesizerId, participant.snapshot);
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
      const result = await this.callAgent(agent, `${PLAN_SYSTEM}${repairInstruction}`, buildDiscussionMessages(task.prompt, completed), signal, async (text) => emit({ type: "delta", taskId, agentId: synthesizerId, text }));
      if (result.error) { this.store.failTurn(turn.id, result.error); throw new Error(result.error); }
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
    try {
      for await (const event of this.gateway({ providerType: agent.providerType, baseUrl: agent.baseUrl, apiKey: agent.apiKey, modelId: agent.modelId, system, temperature: agent.temperature, messages, signal })) {
        if (event.type === "delta") { content += event.text; await delta(event.text); }
        else if (event.type === "done") usage = event.usage;
        else error = event.message;
      }
    } catch {
      error = signal.aborted ? "multi_task_cancelled" : "provider_outcome_unknown";
    }
    return { content, usage, error };
  }

  private snapshots(sessionId: string) {
    return this.db.query<SnapshotRow, [string]>("SELECT agent_id, snapshot_json, position FROM session_agents WHERE session_id = ? ORDER BY position").all(sessionId)
      .map((row) => ({ agentId: row.agent_id, snapshot: JSON.parse(row.snapshot_json) as Record<string, unknown>, position: row.position }));
  }

  private persistAssistantMessage(sessionId: string, agentId: string, content: string): void {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.query("INSERT INTO session_messages (id, session_id, role, author_id, content, status, created_at) VALUES (?, ?, 'assistant', ?, ?, 'completed', ?)").run(id, sessionId, agentId, content, now);
      this.db.query("INSERT INTO message_parts (id, message_id, ordinal, type, text) VALUES (?, ?, 0, 'text', ?)").run(crypto.randomUUID(), id, content);
    })();
  }

  private async stateEvent(taskId: string, sessionId: string, state: string, emit: (event: MultiAgentEvent) => void | Promise<void>) {
    this.events.append({ eventId: `multi-state:${taskId}:${state}:${crypto.randomUUID()}`, sessionId, taskId, type: "multi.state", payload: { state } });
    await emit({ type: "task_state", taskId, state });
  }
}
