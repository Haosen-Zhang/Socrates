import type { ToolRisk } from "./tools";

export type ApprovalDecision = "allow_once" | "allow_session" | "deny";
export interface ApprovalEvidence {
  inputHash: string;
  workspaceIdentity: string;
  attemptId: string;
  policyVersion: number;
}
export interface ApprovalRecord extends ApprovalEvidence {
  decision: ApprovalDecision;
  risk: ToolRisk;
  freshHumanRequired: boolean;
}

export function approvalMatchesExecution(approval: ApprovalRecord, execution: ApprovalEvidence): boolean {
  return approval.decision !== "deny"
    && approval.inputHash === execution.inputHash
    && approval.workspaceIdentity === execution.workspaceIdentity
    && approval.attemptId === execution.attemptId
    && approval.policyVersion === execution.policyVersion;
}

export function canPersistApprovalGrant(approval: ApprovalRecord): boolean {
  return approval.decision === "allow_session" && !approval.freshHumanRequired && (approval.risk === "low" || approval.risk === "medium");
}
