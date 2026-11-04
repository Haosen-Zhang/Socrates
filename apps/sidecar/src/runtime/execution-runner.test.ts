import { describe, expect, it } from "bun:test";
import { UNKNOWN_MODEL_CAPABILITIES, type AgentRuntime, type ApprovalDecision, type RuntimeEvent } from "@socrates/core";
import { ApprovalManager } from "../approvals/manager";
import { openDb } from "../db";
import { MultiTaskStore } from "../multi-agent/task-store";
import { EventStore } from "../store/event-store";
import { ExecutionEventStore } from "../store/execution-event-store";
import { WorkspaceLeaseManager } from "../workspace/leases";
import { ExecutionRunner } from "./execution-runner";
import { RuntimeManager } from "./runtime-manager";

class ApprovalRuntime implements AgentRuntime {
  readonly kind = "fake";
  readonly capabilities = { ...UNKNOWN_MODEL_CAPABILITIES, textInput: true as const, toolCalling: true as const };
  private resolve!: (decision: ApprovalDecision) => void;
  async open() {}
  async *start(): AsyncIterable<RuntimeEvent> {
    yield { type: "extension", name: "provider_attempt_started", payload: { attemptNo: 1 } };
    yield { type: "extension", name: "provider_attempt_completed", payload: { attemptNo: 1 } };
    const decisionPromise = new Promise<ApprovalDecision>((resolve) => { this.resolve = resolve; });
    yield { type: "tool_call", callId: "runtime-approval", name: "shell_command", input: { command: "bun test" } };
    yield { type: "approval_required", requestId: "runtime-approval", callId: "runtime-approval" };
    const decision = await decisionPromise;
    if (decision === "deny") throw new Error("denied");
    yield { type: "status", status: "completed" };
    yield { type: "extension", name: "provider_step_completed", payload: {} };
  }
  async answerApproval(_id: string, decision: ApprovalDecision) { this.resolve(decision); }
  async interrupt() { this.resolve?.("deny"); }
  async close() {}
}

async function setup() {
  const db = openDb(":memory:");
  const now = new Date().toISOString();
  db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES ('w', '/tmp', '/tmp', 'hash', 'tmp', ?, ?)").run(now, now);
  db.query("INSERT INTO sessions (id, title, mode, workspace_id, status, created_at, updated_at) VALUES ('s', 'multi', 'multi_agent', 'w', 'idle', ?, ?)").run(now, now);
  for (const [position, id] of ["a", "b"].entries()) db.query("INSERT INTO session_agents (session_id, agent_id, snapshot_json, position, execution_eligible) VALUES ('s', ?, ?, ?, 1)").run(id, JSON.stringify({ nickname: id, modelId: "fake" }), position);
  const tasks = new MultiTaskStore(db);
  const task = await tasks.create({ sessionId: "s", prompt: "build", config: { speakingOrder: ["a", "b"], maxRounds: 1, synthesizerId: "b", executionAgentId: "a" } });
  tasks.transition(task.id, { type: "prepared_multi" });
  tasks.transition(task.id, { type: "discussion_complete" });
  const plan = await tasks.addPlan({ taskId: task.id, createdBy: "b", content: { objective: "build", summary: "safe", steps: [{ id: "1", title: "test", description: "run", files: [], commands: ["bun test"], risks: [], verification: ["bun test"] }], evidence: [] } });
  tasks.transition(task.id, { type: "plan_ready" });
  tasks.decidePlan({ taskId: task.id, version: plan.version, hash: plan.contentHash, clientDecisionKey: "plan-decision", decision: "approve_exact_plan" });
  const events = new EventStore(db);
  const executionEvents = new ExecutionEventStore(db);
  const runtimes = new RuntimeManager(db, executionEvents);
  runtimes.register("native_ai_sdk", () => new ApprovalRuntime());
  const approvals = new ApprovalManager(db);
  const runner = new ExecutionRunner(db, tasks, runtimes, new WorkspaceLeaseManager(db, "test-instance"), approvals, events, executionEvents);
  return { db, tasks, task, approvals, runner, executionEvents };
}

describe("ExecutionRunner", () => {
  it("fails before Runtime open when the durable Turn start checkpoint is unavailable", async () => {
    const { db, task, runner, executionEvents } = await setup();
    const append = executionEvents.append.bind(executionEvents);
    executionEvents.append = ((input, project) => {
      if (input.type === "turn.started") throw new Error("turn_start_journal_failed");
      return append(input, project);
    }) as typeof executionEvents.append;

    await expect(runner.run(task.id)).rejects.toThrow("turn_start_journal_failed");
    expect(db.query("SELECT COUNT(*) AS count FROM runtime_sessions").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM runtime_events").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM workspace_leases").get()).toEqual({ count: 0 });
  });

  it("holds one write lease and keeps plan approval separate from concrete tool approval", async () => {
    const { db, tasks, task, approvals, runner, executionEvents } = await setup();
    let approvalReady!: () => void;
    const ready = new Promise<void>((resolve) => { approvalReady = resolve; });
    const running = runner.run(task.id, (event) => { if (event.type === "approval_required") approvalReady(); });
    await ready;
    expect(tasks.get(task.id)?.state).toBe("awaiting_tool_approval");
    expect(db.query("SELECT COUNT(*) AS count FROM workspace_leases").get()).toEqual({ count: 1 });
    const request = approvals.recoverPending().pending[0]!;
    expect(request.kind).toBe("shell_command");
    await runner.decide(request.id, { clientDecisionKey: "tool-decision", decision: "allow_once" });
    await running;
    expect(tasks.get(task.id)?.state).toBe("completed");
    const persisted = executionEvents.listAfter(task.id, 0);
    expect(persisted.map((event) => event.type)).toEqual([
      "turn.started",
      "step.started",
      "provider.attempt.started",
      "provider.attempt.completed",
      "runtime.event",
      "runtime.event",
      "runtime.event",
      "step.completed",
      "turn.completed",
    ]);
    expect(new Set(persisted.map((event) => event.coordinates.turnId))).toEqual(new Set([tasks.currentAttemptId(task.id)]));
    expect(db.query("SELECT COUNT(*) AS count FROM workspace_leases").get()).toEqual({ count: 0 });
  });

  it("reconciles a completed multi-agent Turn without writing a contradictory failure", async () => {
    const { tasks, task, approvals, runner, executionEvents } = await setup();
    const append = executionEvents.append.bind(executionEvents);
    let blockCompletion = true;
    executionEvents.append = ((input, project) => {
      if (blockCompletion && input.type === "turn.completed") throw new Error("turn_completion_journal_failed");
      return append(input, project);
    }) as typeof executionEvents.append;
    let approvalReady!: () => void;
    const ready = new Promise<void>((resolve) => { approvalReady = resolve; });
    const running = runner.run(task.id, (event) => {
      if (event.type === "approval_required") approvalReady();
    });
    await ready;
    const request = approvals.recoverPending().pending[0]!;
    await runner.decide(request.id, { clientDecisionKey: "completion-reconcile-decision", decision: "allow_once" });

    await expect(running).rejects.toThrow("turn_completion_journal_failed");
    expect(tasks.get(task.id)?.state).toBe("completed");
    expect(executionEvents.listAfter(task.id, 0).some((event) => event.type === "turn.failed")).toBe(false);

    blockCompletion = false;
    expect(runner.reconcileDurableTurnEvents()).toBe(1);
    expect(executionEvents.listAfter(task.id, 0).filter((event) =>
      event.type === "turn.completed" || event.type === "turn.failed").map((event) => event.type))
      .toEqual(["turn.completed"]);
  });

  it("reconciles a started execution Turn after restart pauses its active attempt", async () => {
    const { db, tasks, task, runner, executionEvents } = await setup();
    const turnId = tasks.currentAttemptId(task.id);
    executionEvents.append({
      eventId: `multi-turn-started:${task.id}:${turnId}`,
      sessionId: task.sessionId,
      runId: task.id,
      agentId: task.executionAgentId!,
      type: "turn.started",
      coordinates: { turnId },
      payload: {},
    });
    db.query("UPDATE multi_tasks SET state = 'paused', terminal_reason = 'sidecar_restarted', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), task.id);

    expect(runner.reconcileDurableTurnEvents()).toBe(1);
    expect(executionEvents.listAfter(task.id, 0).map((event) => event.type))
      .toEqual(["turn.started", "turn.failed"]);
  });

  it("repairs a paused Turn terminal after resume persists the old attempt as paused", async () => {
    const { tasks, task, approvals, runner, executionEvents } = await setup();
    const append = executionEvents.append.bind(executionEvents);
    let blockFailure = true;
    executionEvents.append = ((input, project) => {
      if (blockFailure && input.type === "turn.failed") throw new Error("turn_pause_journal_failed");
      return append(input, project);
    }) as typeof executionEvents.append;
    let approvalReady!: () => void;
    const ready = new Promise<void>((resolve) => { approvalReady = resolve; });
    const running = runner.run(task.id, (event) => {
      if (event.type === "approval_required") approvalReady();
    });
    await ready;
    expect(approvals.recoverPending().pending).toHaveLength(1);

    await runner.pause(task.id);
    await expect(running).rejects.toThrow("turn_pause_journal_failed");
    const oldTurnId = tasks.currentAttemptId(task.id);
    tasks.resumeNewAttempt(task.id, { allowOutcomeUnknown: true });
    blockFailure = false;

    expect(runner.reconcileDurableTurnEvents()).toBe(1);
    const oldTurnEvents = executionEvents.listAfter(task.id, 0)
      .filter((event) => event.coordinates.turnId === oldTurnId)
      .map((event) => event.type);
    expect(oldTurnEvents.at(0)).toBe("turn.started");
    expect(oldTurnEvents.at(-1)).toBe("turn.failed");
  });

  it("refuses execution without an approved exact plan", async () => {
    const { db, task, runner } = await setup();
    db.query("UPDATE multi_tasks SET approved_plan_hash = ? WHERE id = ?").run("wrong", task.id);
    await expect(runner.run(task.id)).rejects.toThrow("approved_plan_required");
  });

  it("pauses execution, expires its pending approval, and releases the write lease", async () => {
    const { db, tasks, task, approvals, runner, executionEvents } = await setup();
    let approvalReady!: () => void;
    const ready = new Promise<void>((resolve) => { approvalReady = resolve; });
    const running = runner.run(task.id, (event) => { if (event.type === "approval_required") approvalReady(); });
    await ready;
    await runner.pause(task.id);
    await expect(running).rejects.toThrow("denied");
    expect(tasks.get(task.id)).toMatchObject({ state: "paused", resumeFrom: "awaiting_tool_approval", terminalReason: "execution_interrupted_requires_review" });
    expect(approvals.recoverPending().pending).toHaveLength(0);
    expect(db.query("SELECT COUNT(*) AS count FROM workspace_leases").get()).toEqual({ count: 0 });

    let resumedApprovalReady!: () => void;
    const resumedReady = new Promise<void>((resolve) => { resumedApprovalReady = resolve; });
    const resumed = runner.resumeAfterReview(task.id, (event) => {
      if (event.type === "approval_required") resumedApprovalReady();
    });
    await resumedReady;
    const resumedRequest = approvals.recoverPending().pending[0]!;
    await runner.decide(resumedRequest.id, { clientDecisionKey: "resumed-tool-decision", decision: "allow_once" });
    await resumed;

    const execution = executionEvents.listAfter(task.id, 0);
    const turnIds = execution.filter((event) => event.type === "turn.started")
      .map((event) => event.coordinates.turnId);
    const stepIds = execution.filter((event) => event.type === "step.started")
      .map((event) => event.coordinates.stepId);
    expect(new Set(turnIds).size).toBe(2);
    expect(new Set(stepIds).size).toBe(2);
    expect(runner.reconcileDurableTurnEvents()).toBe(0);
  });
});
