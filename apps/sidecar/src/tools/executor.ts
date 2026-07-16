import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { approvalMatchesExecution, truncateToolOutput, validateJsonSchemaInput, type PermissionEvaluation, type ToolCallStatus, type ToolContext } from "@socrates/core";
import type { ApprovalManager, DurableApprovalRequest } from "../approvals/manager";
import type { ToolRegistry } from "./registry";

type ToolCallRow = {
  id: string; stable_key: string; session_id: string; task_id: string; attempt_id: string; turn_id: string;
  agent_id: string; name: string; generation: number; input_json: string; input_hash: string;
  workspace_identity: string; policy_version: number; risk: string; idempotency: string;
  status: ToolCallStatus; error: string | null; created_at: string; updated_at: string;
};
type OutputRow = { preview_text: string; byte_size: number; truncated: number; is_error: number };

export interface ToolExecutionRecord {
  id: string;
  stableKey: string;
  status: ToolCallStatus;
  error: string | null;
  approval?: DurableApprovalRequest;
  output?: { preview: string; byteSize: number; truncated: boolean; isError: boolean };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashToolInput(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export class ToolExecutor {
  constructor(
    private readonly db: Database,
    private readonly registry: ToolRegistry,
    private readonly approvals: ApprovalManager,
    private readonly outputLimits = { maxBytes: 64 * 1024, maxLines: 1_000 },
  ) {}

  async invoke(
    request: { stableKey: string; name: string; generation: number; input: unknown; workspaceIdentity: string; policyVersion: number; attemptId?: string },
    context: ToolContext,
    permission: PermissionEvaluation,
  ): Promise<ToolExecutionRecord> {
    const tool = this.registry.resolve(request.name, request.generation);
    const validation = validateJsonSchemaInput(tool.inputSchema, request.input);
    if (validation.length) throw new Error(`invalid_tool_input:${validation.join(",")}`);
    const inputHash = hashToolInput(request.input);
    const existing = this.db.query<ToolCallRow, [string]>("SELECT * FROM tool_calls WHERE stable_key = ?").get(request.stableKey);
    if (existing) {
      if (existing.input_hash !== inputHash) throw new Error("tool_call_key_input_mismatch");
      return this.toRecord(existing);
    }

    const id = context.callId || crypto.randomUUID();
    if (this.db.query("SELECT id FROM tool_calls WHERE id = ?").get(id)) throw new Error("tool_call_id_reused");
    const now = new Date().toISOString();
    const status: ToolCallStatus = permission.effect === "ask" ? "awaiting_approval" : permission.effect === "deny" ? "failed" : "queued";
    const error = permission.effect === "deny" ? permission.reasonCode : null;
    this.db.query(`
      INSERT INTO tool_calls
      (id, stable_key, session_id, task_id, attempt_id, turn_id, agent_id, name, generation, input_json, input_hash,
       workspace_identity, policy_version, risk, idempotency, status, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, request.stableKey, context.sessionId, context.taskId, request.attemptId ?? context.taskId, context.turnId,
      context.agentId, tool.name, tool.generation, JSON.stringify(request.input), inputHash, request.workspaceIdentity,
      request.policyVersion, permission.risk, tool.idempotency, status, error, now, now);

    if (permission.effect === "deny") return this.get(id)!;
    if (permission.effect === "ask") {
      const approval = this.approvals.request({
        taskId: context.taskId, kind: "tool", subjectId: id, inputHash,
        workspaceIdentity: request.workspaceIdentity, attemptId: request.attemptId ?? context.taskId,
        policyVersion: request.policyVersion, risk: permission.risk, freshHumanRequired: permission.freshHumanRequired,
      });
      return { ...this.get(id)!, approval };
    }
    return this.execute(id, tool.execute, request.input, context);
  }

  async resumeApproved(callId: string, context: ToolContext): Promise<ToolExecutionRecord> {
    const row = this.db.query<ToolCallRow, [string]>("SELECT * FROM tool_calls WHERE id = ?").get(callId);
    if (!row) throw new Error("tool_call_not_found");
    if (row.status !== "awaiting_approval") return this.toRecord(row);
    const request = this.approvals.getRequestForSubject(callId);
    const decision = request ? this.approvals.getDecision(request.id) : null;
    if (!request || !decision || request.status !== "allowed") throw new Error("tool_approval_missing");
    if (!approvalMatchesExecution(
      { ...request, decision: decision.decision },
      { inputHash: row.input_hash, workspaceIdentity: row.workspace_identity, attemptId: row.attempt_id, policyVersion: row.policy_version },
    )) throw new Error("tool_approval_evidence_mismatch");
    const tool = this.registry.resolve(row.name, row.generation);
    return this.execute(callId, tool.execute, JSON.parse(row.input_json), { ...context, callId });
  }

  private async execute(id: string, execute: ((input: unknown, context: ToolContext) => Promise<unknown>) | undefined, input: unknown, context: ToolContext): Promise<ToolExecutionRecord> {
    if (!execute) throw new Error("tool_has_no_native_executor");
    this.updateStatus(id, "running");
    try {
      if (context.signal.aborted) throw new Error("tool_cancelled");
      const raw = await execute(input, context);
      const serialized = typeof raw === "string" ? raw : JSON.stringify(raw);
      const output = truncateToolOutput(serialized, this.outputLimits);
      this.db.query(`
        INSERT INTO tool_outputs (tool_call_id, preview_text, byte_size, truncated, is_error)
        VALUES (?, ?, ?, ?, 0)
      `).run(id, output.preview, output.byteSize, output.truncated ? 1 : 0);
      this.updateStatus(id, "succeeded");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.query("UPDATE tool_calls SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(message, new Date().toISOString(), id);
    }
    return this.get(id)!;
  }

  private updateStatus(id: string, status: ToolCallStatus): void {
    this.db.query("UPDATE tool_calls SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), id);
  }

  private get(id: string): ToolExecutionRecord | null {
    const row = this.db.query<ToolCallRow, [string]>("SELECT * FROM tool_calls WHERE id = ?").get(id);
    return row ? this.toRecord(row) : null;
  }

  private toRecord(row: ToolCallRow): ToolExecutionRecord {
    const output = this.db.query<OutputRow, [string]>("SELECT preview_text, byte_size, truncated, is_error FROM tool_outputs WHERE tool_call_id = ?").get(row.id);
    return {
      id: row.id, stableKey: row.stable_key, status: row.status, error: row.error,
      output: output ? { preview: output.preview_text, byteSize: output.byte_size, truncated: output.truncated === 1, isError: output.is_error === 1 } : undefined,
    };
  }
}
