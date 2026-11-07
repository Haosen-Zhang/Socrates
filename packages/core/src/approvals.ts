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
  kind?: string;
  sessionId?: string;
  toolGeneration?: number;
}

export function approvalMatchesExecution(approval: ApprovalRecord, execution: ApprovalEvidence): boolean {
  return approval.decision !== "deny"
    && approval.inputHash === execution.inputHash
    && approval.workspaceIdentity === execution.workspaceIdentity
    && approval.attemptId === execution.attemptId
    && approval.policyVersion === execution.policyVersion;
}

const SESSION_WORKSPACE_WRITERS = new Set(["write_file", "create_directory", "copy_path", "create_archive", "create_document", "create_spreadsheet"]);

export function canAllowSessionApproval(approval: Pick<ApprovalRecord, "risk" | "freshHumanRequired" | "kind" | "sessionId" | "toolGeneration">): boolean {
  return !approval.freshHumanRequired && (approval.risk === "low" || approval.risk === "medium"
    || approval.risk === "high" && SESSION_WORKSPACE_WRITERS.has(approval.kind ?? "") && Boolean(approval.sessionId)
      && Number.isSafeInteger(approval.toolGeneration) && approval.toolGeneration! > 0);
}

export function canPersistApprovalGrant(approval: ApprovalRecord): boolean {
  return approval.decision === "allow_session" && canAllowSessionApproval(approval);
}
