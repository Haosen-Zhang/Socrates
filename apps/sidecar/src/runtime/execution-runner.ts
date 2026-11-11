import { assertTaskWorkflowCompatible } from "../services/workflow-compatibility";
import type { Database } from "bun:sqlite";
import { isCostBudgetPause } from "../services/model-invocation-broker";
import { toolWithinPlanScope, executionEventToRuntimeEvent, type ApprovalDecision, type RuntimeEvent, type StructuredPlan, type ConversationStoredMessage, type ReasoningEffort } from "@socrates/core";
import type { ApprovalManager, DurableApprovalDecision } from "../approvals/manager";
import type { EventStore } from "../store/event-store";
import { hashToolInput } from "../tools/executor";
import type { WorkspaceLeaseManager } from "../workspace/leases";
import type { RuntimeManager } from "./runtime-manager";
import type { MultiTaskStore } from "../multi-agent/task-store";
import { UsageCollector } from "../services/usage-collector";
import type { HistoryStore } from "../store/history-store";
import type { ExecutionEventStore } from "../store/execution-event-store";
import { resolveRunProfile, resolveSessionRunProfile, type RunProfile } from "../services/run-profile";
import { ConversationMemoryStore } from "../store/conversation-memory-store";
import { buildConversationContext } from "../services/conversation-context";
import { ToolExecutionJournal } from "../tools/execution-journal";
import { repairToolHistory } from "../tools/repair-history";
import { taskVerificationTarget, type WorkVerification } from "../services/work-verification";

type ActiveExecution = { runtimeSessionId: string; leaseId: string; calls: Map<string, { name: string; input: unknown }>; cancelled: boolean; paused: boolean;
  package?: { sessionId: string; agentId: string; turnId: string }; controller?: AbortController;
  approvalDeliveries?: Map<string, Promise<void>>; settled: Promise<void>; settle: () => void };

export interface PackageExecutionInput {
  taskId: string;
  packageId: string;
  agentId: string;
  prompt: string;
  plan: StructuredPlan;
  attemptNo: number;
  signal?: AbortSignal;
  previousRunId?: string;
  runProfile?: Record<string, unknown>;
}
export interface PackageExecutionResult {
  status: "completed" | "failed" | "cancelled" | "budget_stopped";
  runId: string;
  result: string;
  reason?: string;
}

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
    private readonly verification?: WorkVerification,
  ) { this.usage = new UsageCollector(db); }

  /** Member execution uses the same runtime/tool/approval pipeline as direct work. */
  async runPackage(input: PackageExecutionInput, emit: (event: RuntimeEvent) => void | Promise<void> = () => {}): Promise<PackageExecutionResult> {
    const task = this.tasks.get(input.taskId);
    if (!task) throw new Error("multi_task_not_found");
    const workspace = this.db.query<{ workspace_id: string | null; identity_hash: string }, [string]>(`
      SELECT sessions.workspace_id, workspaces.identity_hash FROM sessions
      JOIN workspaces ON workspaces.id = sessions.workspace_id WHERE sessions.id = ?
    `).get(task.sessionId);
    if (!workspace?.workspace_id) throw new Error("execution_workspace_required");
    const eligible = this.db.query<{ execution_eligible: number }, [string, string]>(
      "SELECT execution_eligible FROM session_agents WHERE session_id = ? AND agent_id = ?",
    ).get(task.sessionId, input.agentId);
    if (!eligible?.execution_eligible) throw new Error("execution_agent_not_eligible");
    const overrides = task.config.effortByAgent?.[input.agentId]
      ? { reasoningEffort: task.config.effortByAgent[input.agentId] as ReasoningEffort } : {};
    const profile = input.runProfile ? resolveRunProfile(input.agentId, input.runProfile, overrides)
      : resolveSessionRunProfile(this.db, task.sessionId, input.agentId, overrides);
    const runId = `package:${input.packageId}:${input.attemptNo}`;
    if (this.active.has(runId)) throw new Error("execution_already_running");
    const previousEvents = this.executionEvents.listAfter(runId, 0, 2_000);
    while (previousEvents.length && previousEvents.at(-1)!.seq < this.executionEvents.latestSeq(runId)) {
      previousEvents.push(...this.executionEvents.listAfter(runId, previousEvents.at(-1)!.seq, 2_000));
    }
    const terminal = previousEvents.findLast((event) => ["run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(event.type));
    if (previousEvents.length && !terminal) throw new Error("package_execution_requires_recovery");
    if (terminal) {
      const result = previousEvents.flatMap((event) => {
        const projected = executionEventToRuntimeEvent(event);
        return projected?.type === "text_delta" ? [projected.text] : [];
      }).join("");
      if (terminal.type === "run.completed") return { status: "completed", runId, result };
      if (terminal.type === "run.interrupted") return { status: "budget_stopped", runId, result, reason: (terminal.payload as { reason?: string }).reason ?? "budget_exhausted" };
      return { status: terminal.type === "run.cancelled" ? "cancelled" : "failed", runId, result,
        reason: terminal.type === "run.failed" ? (terminal.payload as { error: string }).error : "user_cancelled" };
    }
    const turnId = runId;
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const active: ActiveExecution = { settled, settle, runtimeSessionId: "", leaseId: "", calls: new Map(), cancelled: false, paused: false,
      package: { sessionId: task.sessionId, agentId: input.agentId, turnId }, controller };
    const memory = new ConversationMemoryStore(this.db, this.history);
    const thread = memory.ensureDefaultThread(task.sessionId);
    this.active.set(runId, active);
    let result = "";
    let segment = "";
    let segmentNo = 0;
    let budgetStopped = false;
    let renewal: ReturnType<typeof setInterval> | undefined;
    const coordinates = { turnId };
    const identity = { sessionId: task.sessionId, runId, agentId: input.agentId, coordinates };
    const persistText = async () => {
      if (!segment) return;
      const content = segment; segment = "";
      await memory.appendMessage({ roomId: task.sessionId, threadId: thread.id, runId, turnId,
        agentId: input.agentId, role: "assistant", kind: "text", content, parts: [{ type: "text", text: content }],
        status: budgetStopped ? "interrupted" : "completed", idempotencyKey: `${runId}:segment:${segmentNo++}` });
    };
    try {
      this.executionEvents.append({ ...identity, eventId: `run-created:${runId}`, type: "run.created", payload: { threadId: thread.id, attemptNo: input.attemptNo } });
      this.executionEvents.append({ ...identity, eventId: `turn-started:${runId}`, type: "turn.started", payload: {} });
      const lease = await this.leases.acquireQueued(workspace.workspace_id, runId, { signal: controller.signal,
        onWaiting: () => emit({ type: "extension", name: "workspace_queued", payload: { reason: "workspace_write_lease_busy", runId } }) });
      active.leaseId = lease.id;
      controller.signal.throwIfAborted();
      renewal = setInterval(() => {
        try { this.leases.renew(lease.id, new Date(Date.now() + 30 * 60_000).toISOString()); }
        catch { controller.abort(new Error("workspace_lease_lost")); }
      }, 5 * 60_000);
      // Recheck while owning the writer lease: a queued sibling may have
      // invalidated a prerequisite after the scheduler selected this package.
      const assignment = this.db.query<{definition_json:string},[string]>("SELECT definition_json FROM work_packages WHERE id=?").get(input.packageId);
      const dependencies = assignment ? (JSON.parse(assignment.definition_json) as {dependencies:string[]}).dependencies : [];
      for (const dependency of dependencies) if (this.verification && !this.verification.view(taskVerificationTarget(this.db,input.taskId,dependency)).gatePassed) throw new Error("work_package_dependency_verification_invalidated");
      this.assertEvidenceCurrent(workspace.workspace_id, input.plan.evidence);
      if (input.previousRunId) {
        new ToolExecutionJournal(this.db, this.executionEvents).recoverInterrupted(input.previousRunId);
        await repairToolHistory(this.db, memory, thread.id);
      }
      const previous = input.previousRunId ? (await memory.listThreadMessages(thread.id)).filter((message) =>
        message.agentId === input.agentId && message.runId?.startsWith(`package:${input.packageId}:`)) : [];
      const userContext: ConversationStoredMessage = { messageId: `${runId}:input`, sequence: (previous.at(-1)?.sequence ?? 0) + 1, role: "user",
        roomId: task.sessionId, threadId: thread.id, runId, turnId, agentId: null, kind: "text",
        createdAt: new Date().toISOString(), status: "completed", idempotencyKey: null,
        content: input.prompt, parts: [{ type: "text", text: input.prompt }] };
      const handle = await this.runtimes.open({ runtimeKind: "native_ai_sdk", agentSessionId: runId,
        sessionId: task.sessionId, agentId: input.agentId, workspaceId: workspace.workspace_id,
        runtimeOptions: { sandbox: "workspace-write", runProfile: profile, costRunId: runId,
          costRootTaskId: task.config.costRootTaskId ?? task.config.clientRequestId ?? task.id, costWorkPackageId: input.packageId, costRouteAttemptId:task.config.adaptiveAttemptId } });
      active.runtimeSessionId = handle.id;
      controller.signal.throwIfAborted();
      const preamble: ConversationStoredMessage[] = previous.length ? [{ ...userContext, messageId: `${runId}:continuation`,
        sequence: previous[0]!.sequence - 1, content: "Continue the assigned work using the following durable facts from your earlier attempt. Do not repeat completed side effects.",
        parts: [{ type: "text", text: "Continue the assigned work using the following durable facts from your earlier attempt. Do not repeat completed side effects." }] }] : [];
      const context = buildConversationContext([...preamble, ...previous, userContext], { contextWindowTokens: profile.contextWindowTokens,
        instructionTokens: this.runtimes.contextOverheadTokens(handle.id) });
      if (context.overflow) throw new Error("context_current_unit_exceeds_budget");
      this.executionEvents.append({ ...identity, eventId: `run-started:${runId}`, type: "run.started", payload: {} });
      let usageNo = 0;
      controller.signal.throwIfAborted();
      await this.runtimes.run(handle.id, { taskId: runId, turnId, prompt: input.prompt,
        messages: context.messages, signal: controller.signal,
        onEvent: async (event) => {
          if (event.type === "text_delta") { result += event.text; segment += event.text; }
          if (event.type === "status" && event.status === "interrupted" && event.message === "budget_exhausted") budgetStopped = true;
          if (event.type === "usage") this.usage.record({ stableKey: `${runId}:usage:${usageNo++}`, sessionId: task.sessionId, taskId: runId, agentId: input.agentId, usage: event.usage });
          if (event.type === "tool_call") {
            await persistText();
            active.calls.set(event.callId, { name: event.name, input: event.input });
            await memory.appendMessage({ roomId: task.sessionId, threadId: thread.id, runId, turnId, agentId: input.agentId,
              role: "assistant", kind: "tool_call", content: "", parts: [{ type: "tool_call", callId: event.callId, providerCallId: event.providerCallId, name: event.name, input: event.input }], status: "completed", idempotencyKey: `${runId}:call:${event.callId}` });
          }
          if (event.type === "tool_result") await memory.appendMessage({ roomId: task.sessionId, threadId: thread.id, runId, turnId, agentId: input.agentId,
            role: "tool", kind: "tool_result", content: event.output.preview,
            parts: [{ type: "tool_result", callId: event.callId, providerCallId: event.providerCallId, output: event.output, isError: event.isError }],
            status: event.isError ? "failed" : "completed", idempotencyKey: `${runId}:result:${event.callId}` });
          if (event.type === "approval_required") {
            const call = active.calls.get(event.callId);
            if (!call) throw new Error("approval_without_tool_call");
            const inScope = toolWithinPlanScope(input.plan, call);
            const approval = this.approvals.request({ taskId: runId, kind: inScope ? call.name : "plan_scope_expansion",
              sessionId: task.sessionId, toolGeneration: event.toolGeneration,
              subjectId: `${runId}:${event.requestId}`, inputHash: hashToolInput(call.input), workspaceIdentity: workspace.identity_hash,
              attemptId: runId, policyVersion: event.policyVersion ?? 1, risk: event.risk ?? "high",
              freshHumanRequired: !inScope || event.freshHumanRequired === true });
            this.executionEvents.append({ ...identity, eventId: `approval:${approval.id}`, type: "approval.requested", payload: {
              requestId: approval.id, subjectId: approval.subjectId, callId: event.callId, kind: approval.kind,
              risk: approval.risk, policyVersion: approval.policyVersion, freshHumanRequired: approval.freshHumanRequired } });
            if (this.approvals.hasSessionGrant(approval)) {
              await this.decide(approval.id, { clientDecisionKey: `session-grant:${approval.id}`, decision: "allow_once", reason: "session_grant" });
              return;
            }
            await emit({ ...event, requestId: approval.id });
            return;
          }
          await emit(event);
        } });
      controller.signal.throwIfAborted();
      await persistText();
      if (budgetStopped) {
        this.executionEvents.append({ ...identity, eventId: `turn-budget:${runId}`, type: "turn.failed", payload: { error: "budget_exhausted" } });
        this.executionEvents.append({ ...identity, eventId: `run-budget:${runId}`, type: "run.interrupted", payload: { reason: "budget_exhausted" } });
        return { status: "budget_stopped", runId, result, reason: "budget_exhausted" };
      }
      await this.verification?.verify(taskVerificationTarget(this.db, input.taskId, input.packageId), {
        runId, agentId:input.agentId,signal:controller.signal,leaseId:active.leaseId,
      });
      controller.signal.throwIfAborted();
      this.executionEvents.append({ ...identity, eventId: `turn-completed:${runId}`, type: "turn.completed", payload: {} });
      this.executionEvents.append({ ...identity, eventId: `run-completed:${runId}`, type: "run.completed", payload: {} });
      return { status: "completed", runId, result };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const cancelled = controller.signal.aborted || active.cancelled;
      const costStopped = !cancelled && isCostBudgetPause(error);
      await persistText();
      this.executionEvents.append({ ...identity, eventId: `turn-${cancelled ? "cancelled" : "failed"}:${runId}`,
        type: cancelled ? "turn.cancelled" : "turn.failed", payload: cancelled ? { reason } : { error: reason } });
      this.executionEvents.append({ ...identity, eventId: `run-${cancelled ? "cancelled" : "failed"}:${runId}`,
        type: cancelled ? "run.cancelled" : costStopped ? "run.interrupted" : "run.failed", payload: cancelled || costStopped ? { reason } : { error: reason } });
      return { status: cancelled ? "cancelled" : costStopped ? "budget_stopped" : "failed", runId, result, reason };
    } finally {
      input.signal?.removeEventListener("abort", abort);
      if (renewal) clearInterval(renewal);
      try { if (active.runtimeSessionId) await this.runtimes.close(active.runtimeSessionId); }
      finally {
        if (active.leaseId) this.leases.release(active.leaseId);
        this.approvals.expireForTask(runId);
        this.active.delete(runId);
        active.settle();
      }
    }
  }

  async cancelPackage(runId: string): Promise<void> {
    const active = this.active.get(runId);
    if (!active?.package) return;
    active.cancelled = true;
    active.controller?.abort(new Error("user_cancelled"));
    try { if (active.runtimeSessionId) await this.runtimes.interrupt(active.runtimeSessionId); }
    finally { await active.settled; }
  }

  async run(taskId: string, emit: (event: RuntimeEvent) => void | Promise<void> = () => {}): Promise<void> {
    assertTaskWorkflowCompatible(this.db,taskId);
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
    let budgetStopped = false;
    const controller = new AbortController();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const active: ActiveExecution = { settled, settle, runtimeSessionId: "", leaseId: "", calls: new Map(), cancelled: false, paused: false, controller };
    const turnId = this.tasks.currentAttemptId(taskId);
    const memory = new ConversationMemoryStore(this.db, this.history);
    const thread = memory.ensureDefaultThread(task.sessionId);
    let segmentNo = 0;
    const persistSegment = async (status = "completed") => {
      if (!assistantText.trim()) return;
      const content = assistantText; assistantText = "";
      await memory.appendMessage({ roomId: task.sessionId, threadId: thread.id, runId: taskId, turnId,
        agentId: task.executionAgentId!, role: "assistant", kind: "text", content, parts: [{ type: "text", text: content }],
        status, idempotencyKey: `multi-execution:${taskId}:${turnId}:segment:${segmentNo++}` });
    };
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
      this.active.set(taskId, active);
      lease = await this.leases.acquireQueued(session.workspace_id, taskId, { signal: controller.signal,
        onWaiting: () => emit({ type: "extension", name: "workspace_queued", payload: { reason: "workspace_write_lease_busy", workspaceId: session.workspace_id } }) });
      active.leaseId = lease.id;
      controller.signal.throwIfAborted();
      renewal = setInterval(() => {
        try { this.leases.renew(lease!.id, new Date(Date.now() + 30 * 60_000).toISOString()); }
        catch { void this.cancelForLostLease(taskId); }
      }, 5 * 60_000);
      const snapshot = this.db.query<{ snapshot_json: string; execution_eligible: number }, [string, string]>("SELECT snapshot_json, execution_eligible FROM session_agents WHERE session_id = ? AND agent_id = ?").get(task.sessionId, task.executionAgentId!);
      if (!snapshot || snapshot.execution_eligible !== 1) throw new Error("execution_agent_not_eligible");
      const effort = task.config.effortByAgent?.[task.executionAgentId!];
      let profile = resolveRunProfile(task.executionAgentId!, JSON.parse(snapshot.snapshot_json),
        effort ? { reasoningEffort: effort as ReasoningEffort } : {});
      const frozen = this.db.query<{ checkpoint_json: string }, [string]>(
        "SELECT checkpoint_json FROM multi_task_attempts WHERE task_id = ? AND checkpoint_json IS NOT NULL ORDER BY attempt_no LIMIT 1",
      ).get(taskId);
      if (frozen) profile = (JSON.parse(frozen.checkpoint_json) as { runProfile?: RunProfile }).runProfile ?? profile;
      this.db.query("UPDATE multi_task_attempts SET checkpoint_json = ? WHERE id = ?").run(JSON.stringify({ runProfile: profile }), turnId);
      const handle = await this.runtimes.open({
        runtimeKind: "native_ai_sdk", agentSessionId: `${taskId}:${task.attemptNo}:execution`,
        sessionId: task.sessionId, agentId: task.executionAgentId!, workspaceId: session.workspace_id,
        runtimeOptions: { sandbox: "workspace-write", runProfile: profile, costRunId: taskId,
          costRootTaskId: task.config.costRootTaskId ?? task.config.clientRequestId ?? taskId, costRouteAttemptId:task.config.adaptiveAttemptId },
      });
      runtimeSessionId = handle.id;
      active.runtimeSessionId = runtimeSessionId;
      controller.signal.throwIfAborted();
      new ToolExecutionJournal(this.db, this.executionEvents).recoverInterrupted(taskId);
      await repairToolHistory(this.db, memory, thread.id);
      const previous = (await memory.listThreadMessages(thread.id)).filter((message) => message.runId === taskId && message.agentId === task.executionAgentId);
      const prompt = `Execute only this user-approved plan. Plan approval is not blanket tool approval; request approval for every concrete side effect. Use your previous tool facts and do not repeat completed side effects.\n\n${JSON.stringify(plan.content)}`;
      const instruction: ConversationStoredMessage = { messageId: `${taskId}:${turnId}:input`, sequence: (previous.at(-1)?.sequence ?? 0) + 1,
        roomId: task.sessionId, threadId: thread.id, runId: taskId, turnId, agentId: null, role: "user", kind: "text",
        content: prompt, parts: [{ type: "text", text: prompt }], status: "completed", createdAt: new Date().toISOString(), idempotencyKey: null };
      const preamble: ConversationStoredMessage[] = previous.length ? [{ ...instruction, messageId: `${taskId}:${turnId}:continuation`,
        sequence: previous[0]!.sequence - 1, content: "Continue the approved plan using your own durable work history. Do not repeat completed side effects.",
        parts: [{ type: "text", text: "Continue the approved plan using your own durable work history. Do not repeat completed side effects." }] }] : [];
      const context = buildConversationContext([...preamble, ...previous, instruction], { contextWindowTokens: profile.contextWindowTokens,
        instructionTokens: this.runtimes.contextOverheadTokens(handle.id) });
      if (context.overflow) throw new Error("context_current_unit_exceeds_budget");
      controller.signal.throwIfAborted();
      await this.runtimes.run(runtimeSessionId, {
        taskId,
        turnId,
        signal: controller.signal,
        prompt,
        messages: context.messages,
        onEvent: async (event) => {
          if (event.type === "status" && event.status === "interrupted" && event.message === "budget_exhausted") budgetStopped = true;
          if (event.type === "text_delta") assistantText += event.text;
          if (event.type === "usage") {
            this.usage.record({ stableKey: `multi-execution:${taskId}:${task.attemptNo}:${usageIndex++}`, sessionId: task.sessionId, taskId, agentId: task.executionAgentId, usage: event.usage });
          }
          if (event.type === "tool_call") {
            await persistSegment();
            active.calls.set(event.callId, { name: event.name, input: event.input });
            await memory.appendMessage({ roomId: task.sessionId, threadId: thread.id, runId: taskId, turnId, agentId: task.executionAgentId!,
              role: "assistant", kind: "tool_call", content: "", parts: [{ type: "tool_call", callId: event.callId, providerCallId: event.providerCallId, name: event.name, input: event.input }],
              status: "completed", idempotencyKey: `multi-execution:${taskId}:${turnId}:call:${event.callId}` });
          }
          if (event.type === "tool_result") await memory.appendMessage({ roomId: task.sessionId, threadId: thread.id, runId: taskId, turnId, agentId: task.executionAgentId!,
            role: "tool", kind: "tool_result", content: event.output.preview, parts: [{ type: "tool_result", callId: event.callId, providerCallId: event.providerCallId, output: event.output, isError: event.isError }],
            status: event.isError ? "failed" : "completed", idempotencyKey: `multi-execution:${taskId}:${turnId}:result:${event.callId}` });
          if (event.type === "approval_required") {
            const call = active.calls.get(event.callId);
            if (!call) throw new Error("approval_without_tool_call");
            const workspace = this.db.query<{ identity_hash: string }, [string]>("SELECT identity_hash FROM workspaces WHERE id = ?").get(session.workspace_id!);
            if (!workspace) throw new Error("workspace_not_found");
            const inScope = toolWithinPlanScope(plan.content, call);
            const approval = this.approvals.request({
              taskId, kind: inScope ? call.name : "plan_scope_expansion", subjectId: `${taskId}:${event.requestId}`,
              sessionId: task.sessionId, toolGeneration: event.toolGeneration,
              inputHash: hashToolInput(call.input), workspaceIdentity: workspace.identity_hash,
              attemptId: this.tasks.currentAttemptId(taskId), policyVersion: event.policyVersion ?? 1,
              risk: inScope && call.name !== "file_change" ? event.risk ?? "medium" : "high",
              freshHumanRequired: !inScope || call.name === "file_change" || event.freshHumanRequired === true,
            });
            this.tasks.transition(taskId, { type: "tool_approval_required" });
            this.events.append({ eventId: `multi-tool-approval:${approval.id}`, sessionId: task.sessionId, taskId, type: "approval.requested", payload: approval });
            if (this.approvals.hasSessionGrant(approval)) {
              await this.decide(approval.id, { clientDecisionKey: `session-grant:${approval.id}`, decision: "allow_once", reason: "session_grant" });
              return;
            }
            await emit({ ...event, requestId: approval.id, risk: approval.risk, kind: approval.kind });
            return;
          }
          await emit(event);
        },
      });
      if (budgetStopped && !active.cancelled && !active.paused) {
        await persistSegment("interrupted");
        this.tasks.transition(taskId, { type: "pause", reason: "budget_exhausted" });
        this.executionEvents.append({ eventId: `multi-turn-budget:${taskId}:${turnId}`, sessionId: task.sessionId,
          runId: taskId, agentId: task.executionAgentId!, type: "turn.failed", coordinates: { turnId }, payload: { error: "budget_exhausted" } });
        return;
      }
      if (!active.cancelled && !active.paused) {
        await persistSegment();
        const verification = await this.verification?.verify(taskVerificationTarget(this.db, taskId), {
          runId:taskId,agentId:task.executionAgentId!,signal:controller.signal,leaseId:lease?.id,
        });
        controller.signal.throwIfAborted();
        this.tasks.transition(taskId, verification && !verification.gatePassed ? {type:"pause",reason:"verification_required"} : { type: "complete" });
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
      if (current && !["failed", "cancelled", "completed", "paused"].includes(current.state)) this.tasks.transition(taskId, { type: isCostBudgetPause(error) ? "pause" : "fail", reason: error instanceof Error ? error.message : String(error) });
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
      try { if (runtimeSessionId) await this.runtimes.close(runtimeSessionId); }
      finally {
        if (lease) this.leases.release(lease.id);
        this.approvals.expireForTask(taskId);
        this.active.delete(taskId);
        active.settle();
      }
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
    assertTaskWorkflowCompatible(this.db,request.taskId);
    const taskId = request.taskId;
    if (!request.subjectId.startsWith(`${taskId}:`)) throw new Error("approval_subject_invalid");
    const runtimeRequestId = request.subjectId.slice(taskId.length + 1);
    const active = this.active.get(taskId);
    if (!active) throw new Error("execution_not_active");
    let decision: DurableApprovalDecision;
    try { decision = this.approvals.decide(requestId, input); }
    catch (error) {
      // The decision may already be committed while its journal checkpoint or
      // local delivery failed. A repeated identical choice delivers that fact.
      const previous = this.approvals.getDecision(requestId);
      if (!(error instanceof Error) || error.message !== "approval_already_decided" || previous?.decision !== input.decision) throw error;
      decision = previous;
    }
    const deliveries = active.approvalDeliveries ??= new Map();
    let delivery = deliveries.get(decision.id);
    if (!delivery) {
      delivery = (async () => {
        if (active.package) this.executionEvents.append({ eventId: `approval-decided:${decision.id}`, sessionId: active.package.sessionId,
          runId: taskId, agentId: active.package.agentId, coordinates: { turnId: active.package.turnId },
          type: "approval.decided", payload: { requestId, decision: input.decision } });
        await this.runtimes.answerApproval(active.runtimeSessionId, runtimeRequestId, input.decision);
        if (!active.package) this.tasks.transition(taskId, { type: "tool_approval_settled" });
      })();
      deliveries.set(decision.id, delivery);
    }
    try { await delivery; } catch (error) { deliveries.delete(decision.id); throw error; }
    return decision;
  }

  async cancel(taskId: string): Promise<void> {
    const active = this.active.get(taskId);
    if (!active) throw new Error("execution_not_active");
    active.cancelled = true;
    const task = this.tasks.get(taskId);
    if (task && !["cancelled", "completed", "failed"].includes(task.state)) this.tasks.transition(taskId, { type: "cancel", reason: "user_cancelled" });
    active.controller?.abort(new Error("user_cancelled"));
    try { if (active.runtimeSessionId) await this.runtimes.interrupt(active.runtimeSessionId); }
    finally { await active.settled; }
  }

  async pause(taskId: string): Promise<void> {
    const active = this.active.get(taskId);
    if (!active) throw new Error("execution_not_active");
    const task = this.tasks.get(taskId);
    if (!task || !["executing", "awaiting_tool_approval"].includes(task.state)) throw new Error("multi_task_not_pausable");
    active.paused = true;
    this.tasks.transition(taskId, { type: "pause", reason: "execution_interrupted_requires_review" });
    this.approvals.expireForTask(taskId);
    active.controller?.abort(new Error("user_paused"));
    try { if (active.runtimeSessionId) await this.runtimes.interrupt(active.runtimeSessionId); }
    finally { await active.settled; }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.active].map(async ([id, active]) => {
      if (active.package) await this.cancelPackage(id);
      else if (["executing", "awaiting_tool_approval"].includes(this.tasks.get(id)?.state ?? "")) await this.pause(id);
      else { active.controller?.abort(new Error("sidecar_shutdown")); await active.settled; }
    }));
  }

  private prepareResumeAfterReview(taskId: string): void {
    if (this.active.has(taskId)) throw new Error("execution_already_running");
    const task = this.tasks.get(taskId);
    if (!task || task.state !== "paused" || !["executing", "awaiting_tool_approval"].includes(task.resumeFrom ?? "")) throw new Error("multi_task_execution_resume_invalid");
    const plan = task.approvedPlanVersion ? this.tasks.getPlan(taskId, task.approvedPlanVersion) : null;
    if (!plan || plan.status !== "approved" || plan.contentHash !== task.approvedPlanHash) throw new Error("approved_plan_required");
    const resumed = this.tasks.resumeNewAttempt(taskId, { allowOutcomeUnknown: true });
    if (resumed.state === "awaiting_tool_approval") this.tasks.transition(taskId, { type: "tool_approval_settled" });
  }

  async resumeAfterReview(taskId: string, emit: (event: RuntimeEvent) => void | Promise<void> = () => {}): Promise<void> {
    this.prepareResumeAfterReview(taskId);
    try { await this.run(taskId, emit); }
    catch (error) { this.recordResumeFailure(taskId, error); throw error; }
  }

  resumeInBackgroundAfterReview(taskId: string): void {
    // Validation and ownership reservation happen before returning HTTP 202.
    // A concurrent retry must not turn the existing runner's state into paused.
    this.prepareResumeAfterReview(taskId);
    void this.run(taskId).catch((error) => this.recordResumeFailure(taskId, error));
  }

  private recordResumeFailure(taskId: string, error: unknown): void {
    if (this.tasks.get(taskId)?.state === "executing" && !this.active.has(taskId)) this.tasks.transition(taskId, {
      type: "pause", reason: error instanceof Error ? error.message : "execution_start_failed",
    });
  }

  private async cancelForLostLease(taskId: string): Promise<void> {
    const active = this.active.get(taskId);
    if (!active) return;
    active.cancelled = true;
    const task = this.tasks.get(taskId);
    if (task && !["failed", "cancelled", "completed", "paused"].includes(task.state)) this.tasks.transition(taskId, { type: "fail", reason: "workspace_lease_lost" });
    active.controller?.abort(new Error("workspace_lease_lost"));
    if (active.runtimeSessionId) await this.runtimes.interrupt(active.runtimeSessionId).catch(() => {});
  }

  private assertEvidenceCurrent(workspaceId: string, evidence: Array<{ refId: string; snapshotHash: string }>): void {
    for (const item of evidence) {
      const row = this.db.query<{ workspace_id: string; snapshot_hash: string | null }, [string]>("SELECT workspace_id, snapshot_hash FROM workspace_refs WHERE id = ?").get(item.refId);
      if (!row || row.workspace_id !== workspaceId || row.snapshot_hash !== item.snapshotHash) throw new Error("approved_plan_evidence_stale");
    }
  }

}
