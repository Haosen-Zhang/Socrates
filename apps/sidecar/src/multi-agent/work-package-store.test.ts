import { describe, expect, it } from "bun:test";
import { packageSetup } from "./test-fixtures";
import { ExecutionEventStore } from "../store/execution-event-store";
import { ApprovalManager } from "../approvals/manager";
import { WorkPackageStore } from "./work-package-store";

describe("WorkPackageStore", () => {
  it("holds completed execution and recovered completion behind the current verification gate", () => {
    const { db, definitions } = packageSetup();
    let valid = false;
    const store = new WorkPackageStore(db, () => valid);
    store.replacePlan("t", 1, definitions);
    const first = store.start(store.ready("t")[0]!.id);
    store.finish(first.id, { status: "completed", runId: first.runId!, result: "Worker says all tests passed" });
    expect(store.get(first.id)?.state).toBe("awaiting_verification");
    expect(store.ready("t")).toHaveLength(0);
    valid = true;
    store.reconcileVerification("t");
    expect(store.get(first.id)?.state).toBe("completed");
    expect(store.ready("t")).toHaveLength(1);
    valid = false;
    expect(() => store.start(store.list("t")[1]!.id)).toThrow("work_package_dependency_incomplete");
    store.updateState(first.id, "running");
    new ExecutionEventStore(db).append({ eventId: "execution-only", sessionId: "s", runId: first.runId!, agentId: "a", type: "run.completed", coordinates: {turnId:first.runId!}, payload:{} });
    store.recoverInterrupted();
    expect(store.get(first.id)?.state).toBe("awaiting_verification");
    expect(store.ready("t")).toHaveLength(0);
    db.close();
  });

  it("a reviewer cannot release a dependency when independent checks have become invalid", () => {
    const { db, definitions } = packageSetup();
    let valid = true;
    const store = new WorkPackageStore(db, () => valid);
    store.replacePlan("t", 1, [{...definitions[0]!,reviewerAgentId:"b"},definitions[1]!]);
    const first = store.start(store.ready("t")[0]!.id);
    store.finish(first.id, {status:"completed",runId:first.runId!,result:"done"});
    valid = false;
    store.review(first.id,"approve","Looks fine to me");
    expect(store.get(first.id)?.state).toBe("awaiting_verification");
    expect(store.ready("t")).toHaveLength(0);
    db.close();
  });
  it("recovers a persisted monetary pause before package finish without inventing an unknown failure", () => {
    const { db, store, definitions } = packageSetup();
    store.replacePlan("t", 1, definitions);
    const first = store.start(store.ready("t")[0]!.id);
    new ExecutionEventStore(db).append({ eventId: "cost-pause-before-finish", sessionId: "s", runId: first.runId!, agentId: "a", type: "run.interrupted", coordinates: { turnId: first.runId! }, payload: { reason: "cost_budget_insufficient" } });
    expect(store.recoverInterrupted()).toBe(1);
    expect(store.get(first.id)).toMatchObject({ state: "budget_stopped", failureReason: "cost_budget_insufficient" });
    expect(store.attempts(first.id)[0]).toMatchObject({ status: "budget_stopped", failure_reason: "cost_budget_insufficient" });
    expect(() => store.retry(first.id)).not.toThrow();
    expect(store.ready("t")).toHaveLength(1);
    db.close();
  });
  it("recovers a proven child completion before marking unknown work and expires orphan approvals", () => {
    const { db, store, definitions } = packageSetup();
    store.replacePlan("t", 1, [{ ...definitions[0]!, reviewerAgentId: "b" }, definitions[1]!]);
    const first = store.start(store.ready("t")[0]!.id);
    const events = new ExecutionEventStore(db);
    events.append({ eventId: "proven-completion", sessionId: "s", runId: first.runId!, agentId: "a",
      type: "run.completed", coordinates: { turnId: first.runId! }, payload: {} });
    db.query("INSERT INTO session_messages (id,session_id,role,author_id,content,status,created_at,run_id,kind) VALUES ('segment','s','assistant','a','persisted result','completed','now',?,'text')").run(first.runId!);
    const approvals = new ApprovalManager(db);
    const pending = approvals.request({ taskId: first.runId!, kind: "write_file", subjectId: "pending-call", inputHash: "input",
      workspaceIdentity: "identity", attemptId: first.runId!, policyVersion: 1, risk: "high", freshHumanRequired: true });
    const decided = approvals.request({ taskId: first.runId!, kind: "write_file", subjectId: "decided-call", inputHash: "input",
      workspaceIdentity: "identity", attemptId: first.runId!, policyVersion: 1, risk: "high", freshHumanRequired: true });
    approvals.decide(decided.id, { clientDecisionKey: "historical-decision", decision: "allow_once" });
    expect(store.recoverInterrupted()).toBe(1);
    expect(store.get(first.id)).toMatchObject({ state: "awaiting_review", result: "persisted result", failureReason: null });
    expect(store.attempts(first.id)[0]).toMatchObject({ status: "completed", result: "persisted result" });
    expect(approvals.getRequest(pending.id)?.status).toBe("expired");
    expect(approvals.getDecision(decided.id)?.decision).toBe("allow_once");
    expect(store.ready("t")).toHaveLength(0);
  });

  it("bounds automatic rework and never releases dependants before reviewer approval", () => {
    const { store, definitions } = packageSetup();
    store.replacePlan("t", 1, [{ ...definitions[0]!, reviewerAgentId: "b" }, definitions[1]!]);
    const first = store.start(store.ready("t")[0]!.id);
    store.finish(first.id, { status: "completed", runId: first.runId!, result: "work" });
    expect(store.get(first.id)?.state).toBe("awaiting_review");
    expect(store.ready("t")).toEqual([]);
    store.review(first.id, "request_changes", "missing verification");
    const revision = store.start(first.id);
    store.finish(first.id, { status: "completed", runId: revision.runId!, result: "revision" });
    store.review(first.id, "request_changes", "still incomplete");
    expect(store.get(first.id)).toMatchObject({ state: "failed", failureReason: "review_rework_limit", reworkCount: 1 });
    expect(store.ready("t")).toEqual([]);
  });

  it("persists assignments and gates dependencies on real successful results", () => {
    const { store, definitions } = packageSetup();
    store.replacePlan("t", 1, definitions);
    expect(store.list("t").map((p) => p.state)).toEqual(["ready", "waiting"]);
    const first = store.start(store.list("t")[0]!.id);
    expect(first).toMatchObject({ state: "running", attemptNo: 1, executorAgentId: "a" });
    store.finish(first.id, { status: "failed", runId: first.runId!, result: "", reason: "provider down" });
    expect(store.ready("t")).toEqual([]);
    store.retry(first.id);
    const retry = store.start(first.id);
    store.finish(first.id, { status: "completed", runId: retry.runId!, result: "one done" });
    expect(store.ready("t").map((p) => p.executorAgentId)).toEqual(["b"]);
    expect(store.attempts(first.id)).toHaveLength(2);
  });
  it("recovers interrupted work conservatively and keeps completed facts", () => {
    const { store, definitions } = packageSetup();
    store.replacePlan("t", 1, definitions);
    const first = store.start(store.list("t")[0]!.id);
    store.finish(first.id, { status: "completed", runId: first.runId!, result: "one done" });
    store.start(store.ready("t")[0]!.id);
    expect(store.recoverInterrupted()).toBe(1);
    expect(store.list("t").map((p) => p.state)).toEqual(["completed", "failed"]);
    expect(() => store.retry(store.list("t")[1]!.id)).toThrow("outcome_unknown_confirmation_required");
    store.retry(store.list("t")[1]!.id, true);
    expect(store.ready("t")).toHaveLength(1);
  });
});
