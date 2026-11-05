import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelGateway, OrchestrationAgent } from "@socrates/core";
import { ApprovalManager } from "../approvals/manager";
import { openDb } from "../db";
import { ExecutionRunner } from "../runtime/execution-runner";
import { NativeAgentRuntime, type NativeStreamFactory } from "../runtime/native-agent-runtime";
import { RuntimeManager } from "../runtime/runtime-manager";
import { EventStore } from "../store/event-store";
import { ExecutionEventStore } from "../store/execution-event-store";
import { ToolExecutor } from "../tools/executor";
import { ToolRegistry } from "../tools/registry";
import { createWorkspaceWriteBuiltins } from "../tools/workspace-write-builtins";
import { WorkspaceLeaseManager } from "../workspace/leases";
import { WorkspacePathPolicy } from "../workspace/path-policy";
import { MultiAgentCoordinator } from "./coordinator";
import { UsageCollector, normalizeTokenUsage } from "../services/usage-collector";
import { MultiTaskStore } from "./task-store";
import { TeamRunner } from "./team-runner";
import { WorkPackageStore } from "./work-package-store";
import { teamWorkPackagesMigration } from "../store/migrations/021_team_work_packages";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("manager and native team execution", () => {
  it("runs two assigned members through real tools, exact approvals, a budget stop and persisted continuation", async () => {
    const root = mkdtempSync(join(tmpdir(), "socrates-team-")); roots.push(root);
    const db = openDb(":memory:");
    if (!db.query("SELECT name FROM sqlite_master WHERE name = 'work_packages'").get()) teamWorkPackagesMigration.up(db);
    db.query("INSERT INTO workspaces (id,canonical_path,display_path,identity_hash,label,created_at,last_opened_at) VALUES ('w',?,?,'h','test','now','now')").run(root, root);
    db.exec("INSERT INTO sessions (id,title,mode,kind,workspace_id,status,created_at,updated_at,collaboration_json) VALUES ('s','team','multi_agent','cowork','w','idle','now','now','{\"strategy\":\"team\",\"discussion\":{\"enabled\":false},\"assignment\":{\"coordinatorAgentId\":\"manager\"}}')");
    for (const [position, id] of ["manager", "a", "b"].entries()) db.query("INSERT INTO session_agents (session_id,agent_id,snapshot_json,position,execution_eligible) VALUES ('s',?,?,?,1)").run(id, JSON.stringify({ nickname: id, modelId: `model-${id}`, role: id === "manager" ? "project manager" : "implementer", systemPrompt: `You are ${id}` }), position);
    const packages = new WorkPackageStore(db);
    const tasks = new MultiTaskStore(db);
    const events = new EventStore(db);
    const executionEvents = new ExecutionEventStore(db);
    const approvals = new ApprovalManager(db);
    const plan = { objective: "write two files", summary: "two owners", evidence: [], steps: [{ id: "1", title: "write", description: "write two files", files: ["one.txt", "two.txt"], commands: [], risks: [], verification: ["read files"] }], workPackages: [
      { id: "first", title: "First file", objective: "write one", input: "one.txt", dependencies: [], executorAgentId: "a", reviewerAgentId: null, expectedFiles: ["one.txt"], acceptanceCriteria: ["one.txt contains a"] },
      { id: "second", title: "Second file", objective: "write two", input: "two.txt", dependencies: ["first"], executorAgentId: "b", reviewerAgentId: null, expectedFiles: ["two.txt"], acceptanceCriteria: ["two.txt contains b"] },
    ] };
    let managerCalls = 0;
    const gateway: ModelGateway = async function* (request) { managerCalls++; expect(request.system).toContain("executionAllowed"); yield { type: "delta", text: JSON.stringify(plan) }; yield { type: "done", usage: { inputTokens: 10, outputTokens: 5 } }; };
    const resolve = (id: string, snapshot: Record<string, unknown>): OrchestrationAgent => ({ id, nickname: id, modelId: String(snapshot.modelId), role: String(snapshot.role), systemPrompt: String(snapshot.systemPrompt), providerType: "openai_compatible", baseUrl: "http://fixture", apiKey: "fixture" });
    const coordinator = new MultiAgentCoordinator(db, tasks, events, gateway, resolve);
    const runtimes = new RuntimeManager(db, executionEvents);
    const registry = new ToolRegistry(createWorkspaceWriteBuiltins(new WorkspacePathPolicy(root)));
    const calls: string[] = [];
    let resumedWithToolFacts = false;
    runtimes.register("native_ai_sdk", (opening) => {
      const agent = opening.agentId;
      const stream: NativeStreamFactory = async function* (input) {
        calls.push(agent);
        yield { type: "provider_attempt_started", attemptNo: 1 };
        yield { type: "provider_attempt_completed", attemptNo: 1 };
        const continuing = input.messages.some((m) => m.role === "tool");
        if (!continuing) {
          const callId = `${agent}-write`;
          const tool = input.tools.write_file!;
          const args = { path: agent === "a" ? "one.txt" : "two.txt", content: agent };
          const permission = tool.permission();
          yield { type: "tool_call", callId, name: "write_file", input: args };
          const answer = input.requestApproval({ requestId: callId, callId, name: "write_file", input: args, permission });
          yield { type: "approval_required", requestId: callId, callId, name: "write_file", input: args, permission };
          expect((await answer).approved).toBe(true);
          const output = await tool.execute(args, callId, permission, input.signal);
          yield { type: "tool_result", callId, name: "write_file", output, isError: false };
        } else resumedWithToolFacts = true;
        yield { type: "text_delta", text: `${agent}: file created and readback verified` };
        yield { type: "usage", usage: normalizeTokenUsage({ inputTokens: 100, outputTokens: 25, totalTokens: 125 }) };
        yield { type: "provider_step_completed" };
        if (agent === "b" && !continuing) yield { type: "budget_exhausted", steps: 8 };
      };
      return new NativeAgentRuntime({ sessionId: "s", taskId: opening.agentSessionId, agentId: agent, workspaceId: "w", workspaceIdentity: "h", system: `You are ${agent}`, registry, executor: new ToolExecutor(db, registry, approvals, undefined, executionEvents), stream, allowedCapabilities: ["workspace_write"] });
    });
    const execution = new ExecutionRunner(db, tasks, runtimes, new WorkspaceLeaseManager(db, "test-owner"), approvals, events, executionEvents);
    const task = await coordinator.create({ sessionId: "s", prompt: "write files", config: { speakingOrder: ["a", "b"], maxRounds: 1, synthesizerId: "manager", executionAgentId: "a", teamExecution: true, clientRequestId: "once" } });
    await coordinator.run(task.id);
    expect(managerCalls).toBe(1);
    expect(packages.list(task.id).map((p) => p.executorAgentId)).toEqual(["a", "b"]);
    const approved = tasks.getPlan(task.id)!;
    tasks.decidePlan({ taskId: task.id, version: approved.version, hash: approved.contentHash, clientDecisionKey: "yes", decision: "approve_exact_plan" });
    let approvalCount = 0;
    async function approveUntilDone(promise: Promise<void>) {
      let done = false;
      void promise.finally(() => { done = true; });
      while (!done) {
        for (const request of approvals.recoverPending().pending) { expect(request.kind).toBe("write_file"); approvalCount++; await execution.decide(request.id, { clientDecisionKey: `approve-${request.id}`, decision: "allow_once" }); }
        await Bun.sleep(0);
      }
      await promise;
    }
    const runner = new TeamRunner(db, tasks, packages, execution, coordinator, events);
    await approveUntilDone(runner.run(task.id));
    expect(tasks.get(task.id)?.state).toBe("paused");
    expect(packages.list(task.id).map((p) => p.state)).toEqual(["completed", "budget_stopped"]);
    expect(tasks.usageSummaries(task.id).find((summary) => summary.agentId === "a")).toMatchObject({ records: 1, cumulative: { inputTokens: 100, outputTokens: 25, totalTokens: 125, cost: null } });
    expect(tasks.usageSummaries(task.id).find((summary) => summary.agentId === "b")?.cumulative.totalTokens).toBe(125);
    // Reopen projection and coordinator without rerunning the completed predecessor.
    const reopened = new TeamRunner(db, new MultiTaskStore(db), new WorkPackageStore(db), execution, coordinator, events);
    await approveUntilDone(reopened.retry(task.id, packages.list(task.id)[1]!.id));
    expect(calls).toEqual(["a", "b", "b"]);
    expect(tasks.usageSummaries(task.id).find((summary) => summary.agentId === "b")).toMatchObject({ records: 2, cumulative: { inputTokens: 200, outputTokens: 50, totalTokens: 250, cost: null } });
    expect(tasks.usageSummaries(task.id).find((summary) => summary.agentId === "manager")?.cumulative.totalTokens).toBe(15);
    const child = packages.list(task.id)[1]!;
    const beforeReplay = tasks.usageSummaries(task.id);
    await execution.runPackage({ taskId: task.id, packageId: child.id, agentId: child.executorAgentId, prompt: "retry completed delivery", plan: approved.content, attemptNo: child.attemptNo });
    expect(tasks.usageSummaries(task.id)).toEqual(beforeReplay);
    expect(new UsageCollector(db).sessionSummaries("s").reduce((sum, item) => sum + (item.cumulative.totalTokens ?? 0), 0)).toBe(390);
    expect(approvalCount).toBe(2);
    expect(resumedWithToolFacts).toBe(true);
    expect(readFileSync(join(root, "one.txt"), "utf8")).toBe("a");
    expect(readFileSync(join(root, "two.txt"), "utf8")).toBe("b");
    expect(tasks.get(task.id)?.state).toBe("completed");
    expect(packages.summary(task.id).unfinished).toEqual([]);
    expect(packages.summary(task.id).artifacts.map((a) => a.path)).toEqual(["one.txt", "two.txt"]);
    expect(db.query("SELECT COUNT(*) AS n FROM tool_calls WHERE status = 'succeeded'").get()).toEqual({ n: 2 });
    expect(db.query("SELECT COUNT(*) AS n FROM session_messages WHERE role = 'user'").get()).toEqual({ n: 1 });
    expect(db.query("SELECT COUNT(*) AS n FROM workspace_leases").get()).toEqual({ n: 0 });
  });
});
