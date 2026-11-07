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

  it("persists and reuses an approved workspace writer only within the same room, workspace, tool generation and policy", () => {
    const db = openDb(":memory:"), manager = new ApprovalManager(db);
    const scope = { ...input, kind: "write_file", risk: "high" as const, sessionId: "room-a", toolGeneration: 1 };
    const first = manager.request(scope);
    manager.decide(first.id, { clientDecisionKey: "session-writer", decision: "allow_session" });
    const next = manager.request({ ...scope, subjectId: "new-call", inputHash: "different-content", attemptId: "next-attempt" });
    expect(manager.hasSessionGrant(next)).toBe(true);
    for (const mismatch of [{ sessionId: "room-b" }, { workspaceIdentity: "other" }, { kind: "create_directory" }, { toolGeneration: 2 }, { policyVersion: 3 }, { freshHumanRequired: true }, { kind: "plan_scope_expansion", freshHumanRequired: true }]) {
      expect(manager.hasSessionGrant({ ...next, ...mismatch })).toBe(false);
    }
    db.query("UPDATE permission_grants SET expires_at='2000-01-01'").run();
    expect(manager.hasSessionGrant(next)).toBe(false);
    db.close();
  });
});
