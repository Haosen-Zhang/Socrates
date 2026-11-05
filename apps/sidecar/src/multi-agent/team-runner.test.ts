import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryStore } from "../store/history-store";
import type { StructuredPlan } from "@socrates/core";
import { MultiTaskStore } from "./task-store";
import { TeamRunner, type PackageExecutor } from "./team-runner";
import { packageSetup } from "./test-fixtures";
import { EventStore } from "../store/event-store";

const plan: StructuredPlan = { objective: "two jobs", summary: "two members", evidence: [], steps: [{ id: "1", title: "implement", description: "do jobs", files: [], commands: [], risks: [], verification: ["tests"] }] };

async function setup() {
  const { db, store: packages, definitions } = packageSetup();
  const tasks = new MultiTaskStore(db);
  db.query("UPDATE multi_tasks SET config_json = ?, execution_agent_id = 'a' WHERE id = 't'").run(JSON.stringify({ speakingOrder: ["a", "b"], maxRounds: 1, synthesizerId: "a", executionAgentId: "a", teamExecution: true }));
  const version = await tasks.addPlan({ taskId: "t", content: { ...plan, workPackages: definitions }, createdBy: "a" });
  db.query("UPDATE plan_versions SET status = 'approved' WHERE id = ?").run(version.id);
  db.query("UPDATE multi_tasks SET approved_plan_version = ?, approved_plan_hash = ? WHERE id = 't'").run(version.version, version.contentHash);
  return { db, packages, tasks };
}

describe("TeamRunner", () => {
  it("rejects resume while the paused runner is still persisting its summary without changing its attempt", async () => {
    const { db, tasks, packages } = await setup();
    const directory = mkdtempSync(join(tmpdir(), "socrates-team-settlement-"));
    const history = new HistoryStore(db, directory);
    let summaryStarted!: () => void;
    const persisting = new Promise<void>((resolve) => { summaryStarted = resolve; });
    let releaseSummary!: () => void;
    const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });
    const append = history.appendMessage.bind(history);
    history.appendMessage = async (input, project) => {
      if (input.messageId?.startsWith("team-summary:")) { summaryStarted(); await summaryGate; }
      return append(input, project);
    };
    let reviewing!: () => void;
    const reviewStarted = new Promise<void>((resolve) => { reviewing = resolve; });
    const first = packages.list("t")[0]!;
    db.query("UPDATE work_packages SET definition_json = ? WHERE id = ?").run(JSON.stringify({ ...first, reviewerAgentId: "b" }), first.id);
    let calls = 0;
    const runner = new TeamRunner(db, tasks, packages, {
      async runPackage(input) { calls += 1; return { status: "completed", runId: `package:${input.packageId}:${input.attemptNo}`, result: "done" }; },
      async cancelPackage() {},
    }, { async reviewWorkPackage(_task, _item, signal) {
      reviewing(); await new Promise<void>((resolve) => { signal!.addEventListener("abort", () => resolve(), { once: true }); });
      return { verdict: "approve", notes: "" };
    } }, new EventStore(db), history);
    const running = runner.run("t");
    await reviewStarted;
    const pausing = runner.pause("t");
    await persisting;
    const before = tasks.get("t")!;
    expect(runner.isActive("t")).toBe(true);
    expect(new EventStore(db).listAfter("s", 0).some((event) => event.type === "multi.team_paused")).toBe(false);
    let rejected: unknown;
    try { runner.resumeInBackground("t"); } catch (error) { rejected = error; }
    const after = tasks.get("t")!;
    releaseSummary();
    try {
      await pausing; await running;
      expect(rejected).toBeInstanceOf(Error);
      expect((rejected as Error).message).toBe("team_already_running");
      expect(after).toMatchObject({ state: "paused", attemptNo: before.attemptNo });
      expect(tasks.get("t")?.state).toBe("paused");
      expect(calls).toBe(1);
      expect(runner.isActive("t")).toBe(false);
      expect(new EventStore(db).listAfter("s", 0).some((event) => event.type === "multi.team_paused")).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); db.close(); }
  });

  it("reserves exactly one retry and rejects invalid startup before changing the attempt", async () => {
    const { db, packages, tasks } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const runner = new TeamRunner(db, tasks, packages, {
      async runPackage(input) {
        calls += 1;
        if (calls === 1) return { status: "budget_stopped", runId: `package:${input.packageId}:${input.attemptNo}`, result: "partial" };
        await gate;
        return { status: "completed", runId: `package:${input.packageId}:${input.attemptNo}`, result: "done" };
      }, async cancelPackage() {},
    }, { async reviewWorkPackage() { return { verdict: "approve", notes: "" }; } }, new EventStore(db));
    await runner.run("t");
    const item = packages.list("t")[0]!;
    db.query("UPDATE work_packages SET plan_version = 99 WHERE id = ?").run(item.id);
    expect(() => runner.retryInBackground("t", item.id)).toThrow("work_package_plan_version_mismatch");
    expect(tasks.get("t")).toMatchObject({ state: "paused", attemptNo: 1 });
    expect(packages.get(item.id)?.state).toBe("budget_stopped");
    db.query("UPDATE work_packages SET plan_version = 1 WHERE id = ?").run(item.id);
    runner.retryInBackground("t", item.id);
    expect(() => runner.retryInBackground("t", item.id)).toThrow("team_already_running");
    expect(tasks.get("t")).toMatchObject({ state: "executing", attemptNo: 2 });
    expect(packages.get(item.id)?.attemptNo).toBe(2);
    release();
    while (runner.isActive("t")) await Bun.sleep(0);
    expect(tasks.get("t")?.state).toBe("completed");
    expect(calls).toBe(3);
  });

  it("executes distinct owners in dependency order and retries only the budget-stopped package", async () => {
    const { db, packages, tasks } = await setup();
    const called: string[] = [];
    let stopSecond = true;
    const execution: PackageExecutor = {
      async runPackage(input) {
        called.push(input.agentId);
        if (input.agentId === "b" && stopSecond) return { status: "budget_stopped", runId: `package:${input.packageId}:${input.attemptNo}`, result: "partial b", reason: "model_step_budget_exhausted" };
        return { status: "completed", runId: `package:${input.packageId}:${input.attemptNo}`, result: `${input.agentId} done` };
      },
      async cancelPackage() {},
    };
    const runner = new TeamRunner(db, tasks, packages, execution, { reviewWorkPackage: async () => ({ verdict: "approve", notes: "checks pass" }) }, new EventStore(db));
    await runner.run("t");
    expect(called).toEqual(["a", "b"]);
    expect(tasks.get("t")).toMatchObject({ state: "paused", terminalReason: "work_package_budget_stopped" });
    expect(packages.summary("t").completed).toHaveLength(1);
    stopSecond = false;
    await runner.retry("t", packages.list("t")[1]!.id);
    expect(called).toEqual(["a", "b", "b"]);
    expect(tasks.get("t")?.state).toBe("completed");
    expect(packages.summary("t").unfinished).toHaveLength(0);
    expect(packages.attempts(packages.list("t")[0]!.id)).toHaveLength(1);
  });

  it("invalid reviews fail closed and a review-only retry never reruns the executor", async () => {
    const { db, tasks, packages } = await setup();
    const first = packages.list("t")[0]!;
    const definition = JSON.parse(db.query<{ definition_json: string }, [string]>("SELECT definition_json FROM work_packages WHERE id = ?").get(first.id)!.definition_json);
    db.query("UPDATE work_packages SET definition_json = ? WHERE id = ?").run(JSON.stringify({ ...definition, reviewerAgentId: "b" }), first.id);
    let calls = 0;
    let brokenReview = true;
    const execution: PackageExecutor = { async runPackage(input) { calls += 1; return { status: "completed", runId: `package:${input.packageId}:${input.attemptNo}`, result: "done" }; }, async cancelPackage() {} };
    const runner = new TeamRunner(db, tasks, packages, execution, { reviewWorkPackage: async () => { if (brokenReview) throw new Error("review_output_invalid"); return { verdict: "approve", notes: "verified" }; } }, new EventStore(db));
    await runner.run("t");
    expect(packages.get(first.id)).toMatchObject({ state: "failed", failureReason: "review_output_invalid" });
    expect(calls).toBe(1);
    brokenReview = false;
    await runner.retry("t", first.id);
    expect(calls).toBe(2); // only the dependent package executes after successful review
    expect(tasks.get("t")?.state).toBe("completed");
  });

  it("cancels queued packages and waits for the active member to stop", async () => {
    const { db, tasks, packages } = await setup();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const execution: PackageExecutor = {
      async runPackage(input) { started(); await new Promise<void>((resolve) => { release = resolve; }); return { status: "cancelled", runId: `package:${input.packageId}:${input.attemptNo}`, result: "", reason: "cancelled" }; },
      async cancelPackage() { release(); },
    };
    const runner = new TeamRunner(db, tasks, packages, execution, { reviewWorkPackage: async () => ({ verdict: "approve", notes: "" }) }, new EventStore(db));
    const running = runner.run("t");
    await startedPromise;
    await runner.cancel("t");
    await running;
    expect(packages.list("t").map((p) => p.state)).toEqual(["cancelled", "cancelled"]);
    expect(tasks.get("t")?.state).toBe("cancelled");
  });
});
