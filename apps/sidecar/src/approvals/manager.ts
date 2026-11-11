import { assertTaskWorkflowCompatible } from "../services/workflow-compatibility";
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
  sessionId?: string;
  toolGeneration?: number;
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
  session_id: string | null; tool_generation: number | null;
};
type DecisionRow = { id: string; request_id: string; client_decision_key: string; decision: ApprovalDecision; decided_at: string; reason: string | null };

const toRequest = (row: RequestRow): DurableApprovalRequest => ({
  id: row.id, taskId: row.task_id, kind: row.kind, subjectId: row.subject_id, inputHash: row.input_hash,
  workspaceIdentity: row.workspace_identity, attemptId: row.attempt_id, policyVersion: row.policy_version,
  risk: row.risk, freshHumanRequired: row.fresh_human_required === 1, status: row.status,
  expiresAt: row.expires_at, createdAt: row.created_at,
  sessionId: row.session_id ?? undefined, toolGeneration: row.tool_generation ?? undefined,
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
    if (existing) {
      const saved = toRequest(existing);
      if (saved.kind !== input.kind || saved.risk !== input.risk || saved.freshHumanRequired !== input.freshHumanRequired
        || saved.sessionId !== input.sessionId || saved.toolGeneration !== input.toolGeneration) throw new Error("approval_request_scope_conflict");
      return saved;
    }
    const id = crypto.randomUUID();
    this.db.query(`
      INSERT INTO approval_requests
      (id, task_id, kind, subject_id, input_hash, workspace_identity, attempt_id, policy_version, risk, fresh_human_required, status, expires_at, created_at, session_id, tool_generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(id, input.taskId, input.kind, input.subjectId, input.inputHash, input.workspaceIdentity, input.attemptId,
      input.policyVersion, input.risk, input.freshHumanRequired ? 1 : 0, input.expiresAt ?? null, new Date().toISOString(), input.sessionId ?? null, input.toolGeneration ?? null);
    return toRequest(this.db.query<RequestRow, [string]>("SELECT * FROM approval_requests WHERE id = ?").get(id)!);
  }

  decide(requestId: string, input: { clientDecisionKey: string; decision: ApprovalDecision; reason?: string }): DurableApprovalDecision {
    const owner = this.getRequest(requestId);
    if(owner)assertTaskWorkflowCompatible(this.db,owner.taskId);
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

  hasSessionGrant(request: DurableApprovalRequest, now = new Date().toISOString()): boolean {
    if (!request.sessionId || !request.toolGeneration || !canPersistApprovalGrant({ ...request, decision: "allow_session" })) return false;
    return Boolean(this.db.query(`SELECT 1 FROM permission_grants g JOIN approval_requests r ON r.id=g.request_id
      JOIN approval_decisions d ON d.request_id=r.id AND d.decision='allow_session'
      WHERE g.scope='session' AND r.status='allowed' AND r.fresh_human_required=0
        AND r.session_id=? AND r.workspace_identity=? AND g.workspace_identity=r.workspace_identity
        AND r.kind=? AND r.tool_generation=? AND r.policy_version=? AND r.risk=?
        AND (g.expires_at IS NULL OR g.expires_at>?) LIMIT 1`)
      .get(request.sessionId, request.workspaceIdentity, request.kind, request.toolGeneration, request.policyVersion, request.risk, now));
  }

  expireForTask(taskId: string): number {
    return this.db.query("UPDATE approval_requests SET status = 'expired' WHERE task_id = ? AND status = 'pending'").run(taskId).changes;
  }

  getRequestForSubject(subjectId: string): DurableApprovalRequest | null {
    const row = this.db.query<RequestRow, [string]>("SELECT * FROM approval_requests WHERE subject_id = ? ORDER BY created_at DESC LIMIT 1").get(subjectId);
    return row ? toRequest(row) : null;
  }

  getRequest(id: string): DurableApprovalRequest | null {
    const row = this.db.query<RequestRow, [string]>("SELECT * FROM approval_requests WHERE id = ?").get(id);
    return row ? toRequest(row) : null;
  }

  getDecision(requestId: string): DurableApprovalDecision | null {
    const row = this.db.query<DecisionRow, [string]>("SELECT * FROM approval_decisions WHERE request_id = ? ORDER BY decided_at DESC LIMIT 1").get(requestId);
    return row ? toDecision(row) : null;
  }
}
