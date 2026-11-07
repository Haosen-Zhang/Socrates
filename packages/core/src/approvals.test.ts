import { describe, expect, it } from "bun:test";
import { approvalMatchesExecution, canPersistApprovalGrant } from "./approvals";

describe("approval exactness", () => {
  const approval = {
    inputHash: "input-1",
    workspaceIdentity: "workspace-1",
    attemptId: "attempt-1",
    policyVersion: 3,
    decision: "allow_once" as const,
    risk: "medium" as const,
    freshHumanRequired: false,
  };

  it("invalidates approval when any evidence changes", () => {
    expect(approvalMatchesExecution(approval, { inputHash: "input-1", workspaceIdentity: "workspace-1", attemptId: "attempt-1", policyVersion: 3 })).toBe(true);
    expect(approvalMatchesExecution(approval, { inputHash: "input-2", workspaceIdentity: "workspace-1", attemptId: "attempt-1", policyVersion: 3 })).toBe(false);
    expect(approvalMatchesExecution(approval, { inputHash: "input-1", workspaceIdentity: "workspace-2", attemptId: "attempt-1", policyVersion: 3 })).toBe(false);
  });

  it("never persists fresh-human or unspecified high-risk grants", () => {
    expect(canPersistApprovalGrant({ ...approval, decision: "allow_session" })).toBe(true);
    expect(canPersistApprovalGrant({ ...approval, decision: "allow_session", freshHumanRequired: true })).toBe(false);
    expect(canPersistApprovalGrant({ ...approval, decision: "allow_session", risk: "high" })).toBe(false);
    expect(canPersistApprovalGrant({ ...approval, decision: "allow_session", risk: "high", kind: "write_file", sessionId: "room", toolGeneration: 1 })).toBe(true);
    expect(canPersistApprovalGrant({ ...approval, decision: "allow_session", risk: "high", kind: "write_file" })).toBe(false);
    for (const kind of ["run_shell", "delete_path", "move_path", "plan_scope_expansion"]) {
      expect(canPersistApprovalGrant({ ...approval, decision: "allow_session", risk: "high", kind })).toBe(false);
    }
    expect(canPersistApprovalGrant({ ...approval, decision: "allow_session", risk: "destructive", kind: "write_file" })).toBe(false);
  });
});
