import { describe, expect, it } from "bun:test";
import { UNKNOWN_MODEL_CAPABILITIES, type AgentRuntime, type ApprovalDecision, type RuntimeEvent } from "@socrates/core";
import { ApprovalManager } from "../approvals/manager";
import { openDb } from "../db";
import { MultiTaskStore } from "../multi-agent/task-store";
import { EventStore } from "../store/event-store";
import { WorkspaceLeaseManager } from "../workspace/leases";
import { ExecutionRunner } from "./execution-runner";
import { RuntimeManager } from "./runtime-manager";

class ApprovalRuntime implements AgentRuntime {
  readonly kind = "fake";
  readonly capabilities = { ...UNKNOWN_MODEL_CAPABILITIES, textInput: true as const, toolCalling: true as const };
  private resolve!: (decision: ApprovalDecision) => void;
  async open() {}
  async *start(): AsyncIterable<RuntimeEvent> {
    const decisionPromise = new Promise<ApprovalDecision>((resolve) => { this.resolve = resolve; });
    yield { type: "tool_call", callId: "runtime-approval", name: "shell_command", input: { command: "bun test" } };
    yield { type: "approval_required", requestId: "runtime-approval", callId: "runtime-approval" };
    const decision = await decisionPromise;
    if (decision === "deny") throw new Error("denied");
    yield { type: "status", status: "completed" };
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
  const runtimes = new RuntimeManager(db, events);
  runtimes.register("native_ai_sdk", () => new ApprovalRuntime());
  const approvals = new ApprovalManager(db);
  const runner = new ExecutionRunner(db, tasks, runtimes, new WorkspaceLeaseManager(db, "test-instance"), approvals, events);
  return { db, tasks, task, approvals, runner };
}

describe("ExecutionRunner", () => {
  it("holds one write lease and keeps plan approval separate from concrete tool approval", async () => {
    const { db, tasks, task, approvals, runner } = await setup();
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
    expect(db.query("SELECT COUNT(*) AS count FROM workspace_leases").get()).toEqual({ count: 0 });
  });

  it("refuses execution without an approved exact plan", async () => {
    const { db, task, runner } = await setup();
    db.query("UPDATE multi_tasks SET approved_plan_hash = ? WHERE id = ?").run("wrong", task.id);
    await expect(runner.run(task.id)).rejects.toThrow("approved_plan_required");
  });

  it("pauses execution, expires its pending approval, and releases the write lease", async () => {
    const { db, tasks, task, approvals, runner } = await setup();
    let approvalReady!: () => void;
    const ready = new Promise<void>((resolve) => { approvalReady = resolve; });
    const running = runner.run(task.id, (event) => { if (event.type === "approval_required") approvalReady(); });
    await ready;
    await runner.pause(task.id);
    await expect(running).rejects.toThrow("denied");
    expect(tasks.get(task.id)).toMatchObject({ state: "paused", resumeFrom: "awaiting_tool_approval", terminalReason: "execution_interrupted_requires_review" });
    expect(approvals.recoverPending().pending).toHaveLength(0);
    expect(db.query("SELECT COUNT(*) AS count FROM workspace_leases").get()).toEqual({ count: 0 });
  });
});
