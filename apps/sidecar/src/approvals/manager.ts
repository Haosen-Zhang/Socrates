import type { Database } from "bun:sqlite";
import { canPersistApprovalGrant, type ApprovalDecision, type ApprovalRecord, type ToolRisk } from "@socrates/core";

export interface DurableApprovalRequest {
  id: string;
  taskId: string;
  kind: string;
  subjectId: string;
  inputHash: string;
  workspaceIdentity: string;
  attemptId: string;
  policyVersion: number;
  risk: ToolRisk;
  freshHumanRequired: boolean;
  status: "pending" | "allowed" | "denied" | "expired";
  expiresAt: string | null;
  createdAt: string;
}

export interface DurableApprovalDecision {
  id: string;
  requestId: string;
  clientDecisionKey: string;
  decision: ApprovalDecision;
  decidedAt: string;
  reason: string | null;
}

type RequestRow = {
  id: string; task_id: string; kind: string; subject_id: string; input_hash: string;
  workspace_identity: string; attempt_id: string; policy_version: number; risk: ToolRisk;
  fresh_human_required: number; status: DurableApprovalRequest["status"]; expires_at: string | null; created_at: string;
};
type DecisionRow = { id: string; request_id: string; client_decision_key: string; decision: ApprovalDecision; decided_at: string; reason: string | null };

const toRequest = (row: RequestRow): DurableApprovalRequest => ({
  id: row.id, taskId: row.task_id, kind: row.kind, subjectId: row.subject_id, inputHash: row.input_hash,
  workspaceIdentity: row.workspace_identity, attemptId: row.attempt_id, policyVersion: row.policy_version,
  risk: row.risk, freshHumanRequired: row.fresh_human_required === 1, status: row.status,
  expiresAt: row.expires_at, createdAt: row.created_at,
});
const toDecision = (row: DecisionRow): DurableApprovalDecision => ({
  id: row.id, requestId: row.request_id, clientDecisionKey: row.client_decision_key,
  decision: row.decision, decidedAt: row.decided_at, reason: row.reason,
});

export class ApprovalManager {
  constructor(private readonly db: Database) {}

  request(input: Omit<DurableApprovalRequest, "id" | "status" | "createdAt" | "expiresAt"> & { expiresAt?: string }): DurableApprovalRequest {
    const existing = this.db.query<RequestRow, [string, string, string, string, number]>(`
      SELECT * FROM approval_requests WHERE subject_id = ? AND input_hash = ? AND workspace_identity = ? AND attempt_id = ? AND policy_version = ?
    `).get(input.subjectId, input.inputHash, input.workspaceIdentity, input.attemptId, input.policyVersion);
    if (existing) return toRequest(existing);
    const id = crypto.randomUUID();
    this.db.query(`
      INSERT INTO approval_requests
      (id, task_id, kind, subject_id, input_hash, workspace_identity, attempt_id, policy_version, risk, fresh_human_required, status, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, input.taskId, input.kind, input.subjectId, input.inputHash, input.workspaceIdentity, input.attemptId,
      input.policyVersion, input.risk, input.freshHumanRequired ? 1 : 0, input.expiresAt ?? null, new Date().toISOString());
    return toRequest(this.db.query<RequestRow, [string]>("SELECT * FROM approval_requests WHERE id = ?").get(id)!);
  }

  decide(requestId: string, input: { clientDecisionKey: string; decision: ApprovalDecision; reason?: string }): DurableApprovalDecision {
    const duplicate = this.db.query<DecisionRow, [string]>("SELECT * FROM approval_decisions WHERE client_decision_key = ?").get(input.clientDecisionKey);
    if (duplicate) {
      if (duplicate.request_id !== requestId || duplicate.decision !== input.decision) throw new Error("approval_decision_key_conflict");
      return toDecision(duplicate);
    }
    const requestRow = this.db.query<RequestRow, [string]>("SELECT * FROM approval_requests WHERE id = ?").get(requestId);
    if (!requestRow) throw new Error("approval_request_not_found");
    const request = toRequest(requestRow);
    if (request.status !== "pending") throw new Error("approval_already_decided");
    const record: ApprovalRecord = { ...request, decision: input.decision };
    if (input.decision === "allow_session" && !canPersistApprovalGrant(record)) throw new Error("approval_scope_not_allowed");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.query("INSERT INTO approval_decisions (id, request_id, client_decision_key, decision, decided_at, reason) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, requestId, input.clientDecisionKey, input.decision, now, input.reason ?? null);
      this.db.query("UPDATE approval_requests SET status = ? WHERE id = ?").run(input.decision === "deny" ? "denied" : "allowed", requestId);
      if (input.decision === "allow_session") {
        this.db.query("INSERT INTO permission_grants (id, request_id, workspace_identity, subject_hash, scope) VALUES (?, ?, ?, ?, 'session')")
          .run(crypto.randomUUID(), requestId, request.workspaceIdentity, request.inputHash);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return toDecision(this.db.query<DecisionRow, [string]>("SELECT * FROM approval_decisions WHERE id = ?").get(id)!);
  }

  recoverPending(now = new Date().toISOString()): { expired: number; pending: DurableApprovalRequest[] } {
    const result = this.db.query("UPDATE approval_requests SET status = 'expired' WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?").run(now);
    const pending = this.db.query<RequestRow, []>("SELECT * FROM approval_requests WHERE status = 'pending' ORDER BY created_at").all().map(toRequest);
    return { expired: result.changes, pending };
  }

  getRequestForSubject(subjectId: string): DurableApprovalRequest | null {
    const row = this.db.query<RequestRow, [string]>("SELECT * FROM approval_requests WHERE subject_id = ? ORDER BY created_at DESC LIMIT 1").get(subjectId);
    return row ? toRequest(row) : null;
  }

  getDecision(requestId: string): DurableApprovalDecision | null {
    const row = this.db.query<DecisionRow, [string]>("SELECT * FROM approval_decisions WHERE request_id = ? ORDER BY decided_at DESC LIMIT 1").get(requestId);
    return row ? toDecision(row) : null;
  }
}
