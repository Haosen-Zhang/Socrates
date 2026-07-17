import { describe, expect, it } from "bun:test";
import { openDb } from "../db";
import { ApprovalManager } from "./manager";

describe("ApprovalManager", () => {
  const input = {
    taskId: "task-1", kind: "tool", subjectId: "call-1", inputHash: "hash-1",
    workspaceIdentity: "workspace-1", attemptId: "attempt-1", policyVersion: 2,
    risk: "medium" as const, freshHumanRequired: false,
  };

  it("deduplicates exact requests and decisions by client key", () => {
    const manager = new ApprovalManager(openDb(":memory:"));
    const request = manager.request(input);
    expect(manager.request(input).id).toBe(request.id);
    const decision = manager.decide(request.id, { clientDecisionKey: "client-1", decision: "allow_once" });
    expect(manager.decide(request.id, { clientDecisionKey: "client-1", decision: "allow_once" })).toEqual(decision);
    expect(() => manager.decide(request.id, { clientDecisionKey: "client-1", decision: "deny" })).toThrow("approval_decision_key_conflict");
  });

  it("rejects session grants for fresh-human operations", () => {
    const manager = new ApprovalManager(openDb(":memory:"));
    const request = manager.request({ ...input, subjectId: "danger", inputHash: "danger", risk: "destructive", freshHumanRequired: true });
    expect(() => manager.decide(request.id, { clientDecisionKey: "danger-key", decision: "allow_session" })).toThrow("approval_scope_not_allowed");
  });

  it("expires stale pending requests", () => {
    const manager = new ApprovalManager(openDb(":memory:"));
    manager.request({ ...input, expiresAt: "2020-01-01T00:00:00.000Z" });
    expect(manager.recoverPending("2021-01-01T00:00:00.000Z")).toEqual({ expired: 1, pending: [] });
  });
});
