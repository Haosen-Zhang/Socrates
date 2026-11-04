import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { approvalMatchesExecution, isStructuredExecutionError, StructuredExecutionError, truncateToolOutput, validateJsonSchemaInput, type ExecutionErrorDetail, type PermissionEvaluation, type ToolCallStatus, type ToolContext, type ToolDefinition } from "@socrates/core";
import type { ApprovalManager, DurableApprovalRequest } from "../approvals/manager";
import type { ToolRegistry } from "./registry";
import { ToolExecutionJournal } from "./execution-journal";
import type { ExecutionEventStore } from "../store/execution-event-store";
import { withToolDeadline, assertToolExecutionQuiescent } from "./tool-deadline";
import { ToolOutputStore } from "./output-store";
import { repeatToolReminder } from "@socrates/core";

type ToolCallRow = {
  id: string; stable_key: string; session_id: string; task_id: string; attempt_id: string; turn_id: string;
  agent_id: string; name: string; generation: number; input_json: string; input_hash: string;
  workspace_identity: string; policy_version: number; risk: string; idempotency: string;
  status: ToolCallStatus; error: string | null; error_detail_json: string | null; created_at: string; updated_at: string;
};
type OutputRow = { preview_text: string; byte_size: number; truncated: number; is_error: number; storage_key: string | null };

export interface ToolExecutionRecord {
  id: string;
  stableKey: string;
  status: ToolCallStatus;
  error: string | null;
  errorDetail?: ExecutionErrorDetail;
  approval?: DurableApprovalRequest;
  output?: { preview: string; byteSize: number; truncated: boolean; isError: boolean; storageKey?: string };
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
  private readonly journal: ToolExecutionJournal;
  constructor(
    private readonly db: Database,
    private readonly registry: ToolRegistry,
    private readonly approvals: ApprovalManager,
    private readonly outputLimits = { maxBytes: 64 * 1024, maxLines: 1_000 },
    events?: ExecutionEventStore,
  ) { this.journal = new ToolExecutionJournal(db, events); }

  requiresRecoveryConfirmation(name: string, workspaceIdentity: string): boolean {
    return Boolean(this.db.query(`SELECT 1 FROM tool_calls WHERE name = ? AND workspace_identity = ?
      AND status = 'outcome_unknown' AND idempotency = 'non_idempotent' LIMIT 1`).get(name, workspaceIdentity));
  }

  async invoke(
    request: { stableKey: string; name: string; generation: number; input: unknown; workspaceIdentity: string; policyVersion: number; attemptId?: string },
    context: ToolContext,
    permission: PermissionEvaluation,
  ): Promise<ToolExecutionRecord> {
    assertToolExecutionQuiescent(context);
    const inputHash = hashToolInput(request.input);
    const existing = this.db.query<ToolCallRow, [string]>("SELECT * FROM tool_calls WHERE stable_key = ?").get(request.stableKey);
    if (existing) {
      assertExecutionScope(existing, context);
      if (existing.workspace_identity !== request.workspaceIdentity || existing.policy_version !== request.policyVersion) {
        throw new Error("tool_call_scope_mismatch");
      }
      if (existing.input_hash !== inputHash) throw new Error("tool_call_key_input_mismatch");
      if (existing.name !== request.name || existing.generation !== request.generation) {
        throw new Error("tool_call_key_definition_mismatch");
      }
      return this.toRecord(existing);
    }
    const tool = this.registry.resolve(request.name, request.generation);
    const validation = validateJsonSchemaInput(tool.inputSchema, request.input);
    if (validation.length) throw inputError(validation);
    const semanticValidation = tool.validateInput?.(request.input) ?? [];
    if (semanticValidation.length) throw inputError(semanticValidation);

    const id = context.callId || crypto.randomUUID();
    context = { ...context, callId: id };
    if (this.db.query("SELECT id FROM tool_calls WHERE id = ?").get(id)) throw new Error("tool_call_id_reused");
    const now = new Date().toISOString();
    const status: ToolCallStatus = permission.effect === "ask" ? "awaiting_approval" : permission.effect === "deny" ? "failed" : "queued";
    const error = permission.effect === "deny" ? permissionDenialError(permission) : null;
    const denial: ExecutionErrorDetail | undefined = error ? {
      code: error.split(":")[0]!.toUpperCase(), category: "permission", phase: "approval", retryable: false, message: error,
    } : undefined;
    this.journal.commit(context, `tool-operation:${id}`, "tool.operation.requested", { name: tool.name, inputHash }, () => {
      this.db.query(`
      INSERT INTO tool_calls
      (id, stable_key, session_id, task_id, attempt_id, turn_id, agent_id, name, generation, input_json, input_hash,
       workspace_identity, policy_version, risk, idempotency, status, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, request.stableKey, context.sessionId, context.taskId, request.attemptId ?? context.taskId, context.turnId,
      context.agentId, tool.name, tool.generation, JSON.stringify(request.input), inputHash, request.workspaceIdentity,
      request.policyVersion, permission.risk, tool.idempotency, status, error, now, now);
      this.db.query("UPDATE tool_calls SET step_id = ?, capability = ? WHERE id = ?")
        .run(context.stepId ?? null, tool.capability, id);
      if (denial) {
        const canonical = JSON.stringify({ error: denial });
        const output = truncateToolOutput(canonical, this.outputLimits);
        this.db.query("UPDATE tool_calls SET error_detail_json = ? WHERE id = ?").run(JSON.stringify(denial), id);
        this.db.query(`INSERT INTO tool_outputs (tool_call_id, preview_text, byte_size, truncated, is_error, canonical_json)
          VALUES (?, ?, ?, ?, 1, ?)`).run(id, output.preview, output.byteSize, Number(output.truncated), canonical);
      }
    });

    if (permission.effect === "deny") return this.get(id)!;
    if (permission.effect === "ask") {
      const approval = this.approvals.request({
        taskId: context.taskId, kind: "tool", subjectId: id, inputHash,
        workspaceIdentity: request.workspaceIdentity, attemptId: request.attemptId ?? context.taskId,
        policyVersion: request.policyVersion, risk: permission.risk, freshHumanRequired: permission.freshHumanRequired,
      });
      return { ...this.get(id)!, approval };
    }
    return this.execute(id, tool, request.input, context);
  }

  async resumeApproved(callId: string, context: ToolContext): Promise<ToolExecutionRecord> {
    const row = this.db.query<ToolCallRow, [string]>("SELECT * FROM tool_calls WHERE id = ?").get(callId);
    if (!row) throw new Error("tool_call_not_found");
    assertExecutionScope(row, context);
    if (row.status !== "awaiting_approval") return this.toRecord(row);
    const request = this.approvals.getRequestForSubject(callId);
    const decision = request ? this.approvals.getDecision(request.id) : null;
    if (!request || !decision || request.status !== "allowed") throw new Error("tool_approval_missing");
    if (!approvalMatchesExecution(
      { ...request, decision: decision.decision },
      { inputHash: row.input_hash, workspaceIdentity: row.workspace_identity, attemptId: row.attempt_id, policyVersion: row.policy_version },
    )) throw new Error("tool_approval_evidence_mismatch");
    const tool = this.registry.resolve(row.name, row.generation);
    assertToolExecutionQuiescent(context);
    return this.execute(callId, tool, JSON.parse(row.input_json), { ...context, callId });
  }

  private async execute(id: string, tool: ToolDefinition, input: unknown, context: ToolContext): Promise<ToolExecutionRecord> {
    if (!tool.execute) throw new Error("tool_has_no_native_executor");
    for (let attemptNo = 1; attemptNo <= 3; attemptNo++) {
      const attemptId = this.journal.start(context, attemptNo);
      let raw: unknown;
      let partial: unknown;
      let failure: ExecutionErrorDetail | undefined;
      try {
        if (context.signal.aborted) throw new Error("tool_cancelled");
        const declaredTimeout = tool.timeoutMs ?? 30_000;
        const requestedTimeout = tool.capability === "shell" && input && typeof input === "object" && "timeoutMs" in input
          && typeof input.timeoutMs === "number" ? input.timeoutMs : declaredTimeout;
        raw = await withToolDeadline({ ...context, toolOperationId: id, toolAttemptId: attemptId, idempotencyKey: id },
          Math.min(requestedTimeout, declaredTimeout), (derived) => tool.execute!(input, derived));
        const invalid = tool.outputSchema ? validateJsonSchemaInput(tool.outputSchema, raw) : [];
        if (invalid.length) throw new StructuredExecutionError({ code: "TOOL_OUTPUT_INVALID", category: "tool_validation",
          phase: "tool_validation", retryable: false, message: `Tool executed but returned an invalid result; do not assume its effects failed: ${invalid.join(",")}` });
      } catch (error) {
        if (isStructuredExecutionError(error) && error.detail.code === "TOOL_EXECUTION_UNRESOLVED") throw error;
        failure = classifyToolError(error);
        if (isStructuredExecutionError(error) && "result" in error) partial = error.result;
      }
      const willRetry = Boolean(failure?.retryable && isTransientToolError(failure) && tool.idempotency !== "non_idempotent" && attemptNo < 3 && !context.signal.aborted);
      const status = !failure ? "succeeded" : failure.category === "cancelled" ? "cancelled" : failure.category === "timeout" ? "timed_out" : "failed";
      // Serialization and persistence are outside the body catch. Their failure
      // must leave a started attempt, never claim the effect itself failed.
      let serialized: string | undefined;
      try {
        serialized = failure ? JSON.stringify({ error: failure, ...(partial ? { result: partial } : {}) }) : JSON.stringify(raw);
      } catch (cause) {
        throw new StructuredExecutionError({ code: "TOOL_RESULT_SERIALIZATION_FAILED", category: "persistence",
          phase: "tool_checkpoint", retryable: false, message: cause instanceof Error ? cause.message : String(cause) });
      }
      let rendered = serialized ?? "null";
      try {
        if (!failure) {
          const projection = tool.renderOutput ? tool.renderOutput(raw) : raw;
          rendered = typeof projection === "string" ? projection : JSON.stringify(projection) ?? "null";
        }
      } catch (cause) {
        throw new StructuredExecutionError({ code: "TOOL_RESULT_RENDER_FAILED", category: "persistence", phase: "tool_checkpoint",
          retryable: false, message: cause instanceof Error ? cause.message : String(cause) });
      }
      const row = this.db.query<ToolCallRow, [string]>("SELECT * FROM tool_calls WHERE id = ?").get(id)!;
      const recent = this.db.query<{ name: string; input_hash: string }, [string, string]>(`SELECT name, input_hash FROM tool_calls
        WHERE task_id = ? AND agent_id = ? ORDER BY rowid DESC LIMIT 9`).all(context.taskId, context.agentId);
      let repetitions = 0;
      for (const call of recent) { if (call.name !== tool.name || call.input_hash !== row.input_hash) break; repetitions++; }
      const reminder = repeatToolReminder(tool.name, repetitions);
      if (reminder) rendered = `[Tool guidance]\n${reminder}\n[Tool result]\n${rendered}`;
      const output = truncateToolOutput(rendered, this.outputLimits);
      let storageKey: string | undefined;
      if (!willRetry && (output.truncated || Buffer.byteLength(serialized ?? "null") > this.outputLimits.maxBytes)) {
        try { storageKey = new ToolOutputStore(this.db).put({ sessionId: context.sessionId, workspaceIdentity: row.workspace_identity }, serialized ?? "null", id); }
        catch (cause) {
          throw new StructuredExecutionError({ code: "TOOL_RESULT_STORAGE_FAILED", category: "persistence", phase: "tool_checkpoint",
            retryable: false, message: cause instanceof Error ? cause.message : String(cause) });
        }
      }
      this.journal.result(context, attemptId, status, { ...output, storageKey, canonicalJson: storageKey ? undefined : serialized ?? "null" }, failure, willRetry);
      if (!willRetry) break;
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); context.signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, Math.min(250 * 2 ** (attemptNo - 1), 1_000));
        context.signal.addEventListener("abort", done, { once: true });
      });
    }
    return this.get(id)!;
  }

  private get(id: string): ToolExecutionRecord | null {
    const row = this.db.query<ToolCallRow, [string]>("SELECT * FROM tool_calls WHERE id = ?").get(id);
    return row ? this.toRecord(row) : null;
  }

  private toRecord(row: ToolCallRow): ToolExecutionRecord {
    const output = this.db.query<OutputRow, [string]>("SELECT preview_text, byte_size, truncated, is_error, storage_key FROM tool_outputs WHERE tool_call_id = ?").get(row.id);
    return {
      id: row.id, stableKey: row.stable_key, status: row.status, error: row.error,
      ...(row.error_detail_json ? { errorDetail: JSON.parse(row.error_detail_json) } : {}),
      output: output ? { preview: output.preview_text, byteSize: output.byte_size, truncated: output.truncated === 1,
        isError: output.is_error === 1, ...(output.storage_key ? { storageKey: output.storage_key } : {}) } : undefined,
    };
  }
}

function inputError(errors: string[]): StructuredExecutionError {
  return new StructuredExecutionError({ code: "TOOL_INPUT_INVALID", category: "tool_validation", phase: "tool_validation",
    retryable: false, message: `invalid_tool_input:${errors.join(",")}` });
}

function assertExecutionScope(row: ToolCallRow, context: ToolContext): void {
  if (row.session_id !== context.sessionId || row.task_id !== context.taskId || row.turn_id !== context.turnId || row.agent_id !== context.agentId) {
    throw new Error("tool_call_scope_mismatch");
  }
}

function isTransientToolError(error: ExecutionErrorDetail): boolean {
  return ["network", "rate_limit", "timeout"].includes(error.category)
    || error.category === "tool_execution" && ["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ETIMEDOUT"].includes(error.code);
}

function classifyToolError(error: unknown): ExecutionErrorDetail {
  if (isStructuredExecutionError(error)) return error.detail;
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code
    : /^[A-Za-z]+(?:_[A-Za-z0-9]+)+$/.test(message) ? message.toUpperCase() : "TOOL_EXECUTION_FAILED";
  const cancelled = message === "tool_cancelled" || error instanceof DOMException && error.name === "AbortError";
  const timeout = message === "tool_timed_out" || code === "ETIMEDOUT";
  const validation = message.startsWith("invalid_tool_input:") || message.startsWith("invalid_tool_output_");
  const denied = code.endsWith("_DENIED") || code === "WORKSPACE_PATH_TRAVERSAL" || code === "WORKSPACE_PATH_OUTSIDE";
  return { code: cancelled ? "TOOL_CANCELLED" : timeout ? "TOOL_TIMEOUT" : code,
    category: cancelled ? "cancelled" : timeout ? "timeout" : validation ? "tool_validation" : denied ? "permission" : "tool_execution",
    phase: validation ? "tool_validation" : "tool_execution",
    retryable: !cancelled && ["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ETIMEDOUT"].includes(code), message };
}

function permissionDenialError(permission: PermissionEvaluation): string {
  const capabilityReasons = new Set(["capability_ceiling", "mode_ceiling", "phase_ceiling"]);
  const category = capabilityReasons.has(permission.reasonCode) ? "capability_denied" : "policy_denied";
  return `${category}:${permission.reasonCode}`;
}
