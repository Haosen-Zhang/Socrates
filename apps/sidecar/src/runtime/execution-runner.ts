import type { Database } from "bun:sqlite";
import { toolWithinPlanScope, type ApprovalDecision, type RuntimeEvent } from "@socrates/core";
import type { ApprovalManager, DurableApprovalDecision } from "../approvals/manager";
import type { EventStore } from "../store/event-store";
import { hashToolInput } from "../tools/executor";
import type { WorkspaceLeaseManager } from "../workspace/leases";
import type { RuntimeManager } from "./runtime-manager";
import type { MultiTaskStore } from "../multi-agent/task-store";
import { UsageCollector } from "../services/usage-collector";
import type { HistoryStore } from "../store/history-store";
import type { ExecutionEventStore } from "../store/execution-event-store";

type ActiveExecution = { runtimeSessionId: string; leaseId: string; calls: Map<string, { name: string; input: unknown }>; cancelled: boolean; paused: boolean };

export class ExecutionRunner {
  private readonly active = new Map<string, ActiveExecution>();
  private readonly usage: UsageCollector;

  constructor(
    private readonly db: Database,
    private readonly tasks: MultiTaskStore,
    private readonly runtimes: RuntimeManager,
    private readonly leases: WorkspaceLeaseManager,
    private readonly approvals: ApprovalManager,
    private readonly events: EventStore,
    private readonly executionEvents: ExecutionEventStore,
    private readonly history?: HistoryStore,
  ) { this.usage = new UsageCollector(db); }

  async run(taskId: string, emit: (event: RuntimeEvent) => void | Promise<void> = () => {}): Promise<void> {
    if (this.active.has(taskId)) throw new Error("execution_already_running");
    const task = this.tasks.get(taskId);
    const plan = task?.approvedPlanVersion ? this.tasks.getPlan(taskId, task.approvedPlanVersion) : null;
    if (!task || task.state !== "executing" || !plan || plan.status !== "approved" || plan.contentHash !== task.approvedPlanHash) throw new Error("approved_plan_required");
    const session = this.db.query<{ workspace_id: string | null }, [string]>("SELECT workspace_id FROM sessions WHERE id = ?").get(task.sessionId);
    if (!session?.workspace_id) throw new Error("execution_workspace_required");
    let lease: ReturnType<WorkspaceLeaseManager["acquire"]> | undefined;
    let renewal: ReturnType<typeof setInterval> | undefined;
    let runtimeSessionId = "";
    let assistantText = "";
    let usageIndex = 0;
    let turnStarted = false;
    const turnId = this.tasks.currentAttemptId(taskId);
    try {
      this.executionEvents.append({
        eventId: `multi-turn-started:${taskId}:${turnId}`,
        sessionId: task.sessionId,
        runId: taskId,
        agentId: task.executionAgentId!,
        type: "turn.started",
        coordinates: { turnId },
        payload: {},
      });
      turnStarted = true;
      this.assertEvidenceCurrent(session.workspace_id, plan.content.evidence);
      lease = this.leases.acquire(session.workspace_id, taskId, "write", new Date(Date.now() + 30 * 60_000).toISOString());
      renewal = setInterval(() => {
        try { this.leases.renew(lease!.id, new Date(Date.now() + 30 * 60_000).toISOString()); }
        catch { void this.cancelForLostLease(taskId); }
      }, 5 * 60_000);
      const snapshot = this.db.query<{ snapshot_json: string; execution_eligible: number }, [string, string]>("SELECT snapshot_json, execution_eligible FROM session_agents WHERE session_id = ? AND agent_id = ?").get(task.sessionId, task.executionAgentId!);
      if (!snapshot || snapshot.execution_eligible !== 1) throw new Error("execution_agent_not_eligible");
      const profile = JSON.parse(snapshot.snapshot_json) as Record<string, unknown>;
      const handle = await this.runtimes.open({
        runtimeKind: "native_ai_sdk", agentSessionId: `${taskId}:${task.attemptNo}:execution`,
        sessionId: task.sessionId, agentId: task.executionAgentId!, workspaceId: session.workspace_id,
        runtimeOptions: { sandbox: "workspace-write", model: typeof profile.modelId === "string" ? profile.modelId : undefined },
      });
      runtimeSessionId = handle.id;
      const active: ActiveExecution = { runtimeSessionId, leaseId: lease.id, calls: new Map(), cancelled: false, paused: false };
      this.active.set(taskId, active);
      await this.runtimes.run(runtimeSessionId, {
        taskId,
        turnId,
        prompt: `Execute only this user-approved plan. Plan approval is not blanket tool approval; request approval for every concrete side effect.\n\n${JSON.stringify(plan.content)}`,
        onEvent: async (event) => {
          if (event.type === "text_delta") assistantText += event.text;
          if (event.type === "usage") {
            this.usage.record({ stableKey: `multi-execution:${taskId}:${task.attemptNo}:${usageIndex++}`, sessionId: task.sessionId, taskId, agentId: task.executionAgentId, usage: event.usage });
          }
          if (event.type === "tool_call") active.calls.set(event.callId, { name: event.name, input: event.input });
          if (event.type === "approval_required") {
            const call = active.calls.get(event.callId);
            if (!call) throw new Error("approval_without_tool_call");
            const workspace = this.db.query<{ identity_hash: string }, [string]>("SELECT identity_hash FROM workspaces WHERE id = ?").get(session.workspace_id!);
            if (!workspace) throw new Error("workspace_not_found");
            const inScope = toolWithinPlanScope(plan.content, call);
            const approval = this.approvals.request({
              taskId, kind: inScope ? call.name : "plan_scope_expansion", subjectId: `${taskId}:${event.requestId}`,
              inputHash: hashToolInput(call.input), workspaceIdentity: workspace.identity_hash,
              attemptId: this.tasks.currentAttemptId(taskId), policyVersion: 1,
              risk: inScope && call.name !== "file_change" ? "medium" : "high", freshHumanRequired: !inScope || call.name === "file_change",
            });
            this.tasks.transition(taskId, { type: "tool_approval_required" });
            this.events.append({ eventId: `multi-tool-approval:${approval.id}`, sessionId: task.sessionId, taskId, type: "approval.requested", payload: approval });
            await emit({ ...event, requestId: approval.id, risk: approval.risk, kind: approval.kind });
            return;
          }
          await emit(event);
        },
      });
      if (!active.cancelled && !active.paused) {
        if (assistantText.trim()) await this.persistAssistantMessage(task.sessionId, task.executionAgentId!, assistantText);
        this.tasks.transition(taskId, { type: "complete" });
        this.executionEvents.append({
          eventId: `multi-turn-completed:${taskId}:${turnId}`,
          sessionId: task.sessionId,
          runId: taskId,
          agentId: task.executionAgentId!,
          type: "turn.completed",
          coordinates: { turnId },
          payload: {},
        });
      }
    } catch (error) {
      const current = this.tasks.get(taskId);
      if (current && !["failed", "cancelled", "completed", "paused"].includes(current.state)) this.tasks.transition(taskId, { type: "fail", reason: error instanceof Error ? error.message : String(error) });
      const terminal = this.tasks.get(taskId);
      if (!turnStarted || terminal?.state === "completed") throw error;
      const cancelled = terminal?.state === "cancelled";
      this.executionEvents.append({
        eventId: `multi-turn-${cancelled ? "cancelled" : "failed"}:${taskId}:${turnId}`,
        sessionId: task.sessionId,
        runId: taskId,
        agentId: task.executionAgentId!,
        type: cancelled ? "turn.cancelled" : "turn.failed",
        coordinates: { turnId },
        payload: cancelled
          ? { reason: terminal?.terminalReason ?? "user_cancelled" }
          : { error: terminal?.terminalReason ?? (error instanceof Error ? error.message : String(error)) },
      });
      throw error;
    } finally {
      if (renewal) clearInterval(renewal);
      if (runtimeSessionId) await this.runtimes.close(runtimeSessionId);
      if (lease) this.leases.release(lease.id);
      this.active.delete(taskId);
    }
  }

  reconcileDurableTurnEvents(): number {
    const attempts = this.db.query<{
      turn_id: string;
      task_id: string;
      session_id: string;
      agent_id: string;
      status: "active" | "paused" | "completed" | "failed" | "cancelled";
      ended_at: string | null;
      terminal_reason: string | null;
    }, []>(`
      SELECT multi_task_attempts.id AS turn_id, multi_tasks.id AS task_id,
             multi_tasks.session_id, multi_tasks.execution_agent_id AS agent_id,
             multi_task_attempts.status,
             COALESCE(multi_task_attempts.ended_at, multi_tasks.updated_at) AS ended_at,
             multi_tasks.terminal_reason
      FROM multi_task_attempts
      JOIN multi_tasks ON multi_tasks.id = multi_task_attempts.task_id
      WHERE multi_tasks.execution_agent_id IS NOT NULL
        AND (
          multi_task_attempts.status IN ('paused', 'completed', 'failed', 'cancelled')
          OR (multi_task_attempts.status = 'active' AND multi_tasks.state = 'paused')
        )
        AND EXISTS (
          SELECT 1 FROM runtime_events
          WHERE id = 'multi-turn-started:' || multi_tasks.id || ':' || multi_task_attempts.id
            AND schema_version = 1
        )
        AND NOT EXISTS (
          SELECT 1 FROM runtime_events
          WHERE runtime_events.run_id = multi_tasks.id
            AND runtime_events.turn_id = multi_task_attempts.id
            AND runtime_events.schema_version = 1
            AND runtime_events.type IN ('turn.completed', 'turn.failed', 'turn.cancelled')
        )
    `).all();
    let repaired = 0;
    for (const attempt of attempts) {
      const terminalStatus = attempt.status === "active" || attempt.status === "paused"
        ? "failed"
        : attempt.status;
      const type = terminalStatus === "completed"
        ? "turn.completed" as const
        : terminalStatus === "cancelled"
          ? "turn.cancelled" as const
          : "turn.failed" as const;
      const before = this.executionEvents.latestSeq(attempt.task_id);
      this.executionEvents.append({
        eventId: `multi-turn-${terminalStatus}:${attempt.task_id}:${attempt.turn_id}`,
        sessionId: attempt.session_id,
        runId: attempt.task_id,
        agentId: attempt.agent_id,
        type,
        coordinates: { turnId: attempt.turn_id },
        payload: type === "turn.completed"
          ? {}
          : type === "turn.cancelled"
            ? { reason: attempt.terminal_reason ?? "cancelled" }
            : { error: attempt.terminal_reason ?? "failed" },
        occurredAt: attempt.ended_at ?? undefined,
      });
      if (this.executionEvents.latestSeq(attempt.task_id) > before) repaired += 1;
    }
    return repaired;
  }

  async decide(requestId: string, input: { clientDecisionKey: string; decision: ApprovalDecision; reason?: string }): Promise<DurableApprovalDecision> {
    const request = this.approvals.getRequest(requestId);
    if (!request) throw new Error("approval_request_not_found");
    const separator = request.subjectId.indexOf(":");
    const taskId = separator > 0 ? request.subjectId.slice(0, separator) : "";
    const runtimeRequestId = separator > 0 ? request.subjectId.slice(separator + 1) : "";
    const active = this.active.get(taskId);
    if (!active) throw new Error("execution_not_active");
    const decision = this.approvals.decide(requestId, input);
    await this.runtimes.answerApproval(active.runtimeSessionId, runtimeRequestId, input.decision);
    this.tasks.transition(taskId, { type: "tool_approval_settled" });
    return decision;
  }

  async cancel(taskId: string): Promise<void> {
    const active = this.active.get(taskId);
    if (!active) throw new Error("execution_not_active");
    active.cancelled = true;
    await this.runtimes.interrupt(active.runtimeSessionId);
    const task = this.tasks.get(taskId);
    if (task && !["cancelled", "completed", "failed"].includes(task.state)) this.tasks.transition(taskId, { type: "cancel", reason: "user_cancelled" });
  }

  async pause(taskId: string): Promise<void> {
    const active = this.active.get(taskId);
    if (!active) throw new Error("execution_not_active");
    const task = this.tasks.get(taskId);
    if (!task || !["executing", "awaiting_tool_approval"].includes(task.state)) throw new Error("multi_task_not_pausable");
    active.paused = true;
    this.tasks.transition(taskId, { type: "pause", reason: "execution_interrupted_requires_review" });
    this.approvals.expireForTask(taskId);
    await this.runtimes.interrupt(active.runtimeSessionId);
  }

  async resumeAfterReview(taskId: string, emit: (event: RuntimeEvent) => void | Promise<void> = () => {}): Promise<void> {
    const resumed = this.tasks.resumeNewAttempt(taskId, { allowOutcomeUnknown: true });
    if (resumed.state === "awaiting_tool_approval") this.tasks.transition(taskId, { type: "tool_approval_settled" });
    if (this.tasks.get(taskId)?.state !== "executing") throw new Error("multi_task_execution_resume_invalid");
    await this.run(taskId, emit);
  }

  private async cancelForLostLease(taskId: string): Promise<void> {
    const active = this.active.get(taskId);
    if (!active) return;
    active.cancelled = true;
    await this.runtimes.interrupt(active.runtimeSessionId).catch(() => {});
    const task = this.tasks.get(taskId);
    if (task && !["failed", "cancelled", "completed"].includes(task.state)) this.tasks.transition(taskId, { type: "fail", reason: "workspace_lease_lost" });
  }

  private assertEvidenceCurrent(workspaceId: string, evidence: Array<{ refId: string; snapshotHash: string }>): void {
    for (const item of evidence) {
      const row = this.db.query<{ workspace_id: string; snapshot_hash: string | null }, [string]>("SELECT workspace_id, snapshot_hash FROM workspace_refs WHERE id = ?").get(item.refId);
      if (!row || row.workspace_id !== workspaceId || row.snapshot_hash !== item.snapshotHash) throw new Error("approved_plan_evidence_stale");
    }
  }

  private async persistAssistantMessage(sessionId: string, agentId: string, content: string): Promise<void> {
    const messageId = crypto.randomUUID();
    const now = new Date().toISOString();
    if (this.history) {
      await this.history.appendMessage({ messageId, roomId: sessionId, threadId: `thread:${sessionId}`,
        runId: null, turnId: null, agentId, role: "assistant", kind: "text", content,
        parts: [{ type: "text", text: content }], status: "completed", idempotencyKey: `execution-assistant:${messageId}`, createdAt: now });
      return;
    }
    this.db.transaction(() => {
      this.db.query("INSERT INTO session_messages (id, session_id, role, author_id, content, status, created_at) VALUES (?, ?, 'assistant', ?, ?, 'completed', ?)").run(messageId, sessionId, agentId, content, now);
      this.db.query("INSERT INTO message_parts (id, message_id, ordinal, type, text) VALUES (?, ?, 0, 'text', ?)").run(crypto.randomUUID(), messageId, content);
    })();
  }
}
