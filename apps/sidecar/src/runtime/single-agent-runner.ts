import type { Database } from "bun:sqlite";
import type { ApprovalDecision, MessagePart, RuntimeEvent } from "@socrates/core";
import type { ApprovalManager, DurableApprovalDecision } from "../approvals/manager";
import { hashToolInput } from "../tools/executor";
import type { RuntimeManager } from "./runtime-manager";
import type { EventStore } from "../store/event-store";
import type { AttachmentResolver } from "../attachments/resolver";
import { UsageCollector } from "../services/usage-collector";

type SessionRow = { id: string; mode: string; workspace_id: string | null; status: string };
type WorkspaceRow = { identity_hash: string };
type AgentRow = { agent_id: string };
type WorkspaceRefRow = { id: string; workspace_id: string; relative_path: string; snapshot_hash: string | null };
type ActiveRun = { runtimeSessionId: string; calls: Map<string, { name: string; input: unknown }>; cancelled: boolean };

export interface AgentRunResult {
  id: string;
  sessionId: string;
  runtimeSessionId: string;
  status: "completed" | "failed" | "cancelled";
  error?: string;
}

export class SingleAgentRunner {
  private readonly active = new Map<string, ActiveRun>();
  private readonly usage: UsageCollector;

  constructor(
    private readonly db: Database,
    private readonly runtimes: RuntimeManager,
    private readonly approvals: ApprovalManager,
    private readonly events: EventStore,
    private readonly attachments: AttachmentResolver,
  ) { this.usage = new UsageCollector(db); }

  recoverInterrupted(): { runs: number; approvals: number } {
    let runs = 0;
    let approvals = 0;
    this.db.transaction(() => {
      approvals = this.db.query(`
        UPDATE approval_requests SET status = 'expired'
        WHERE status = 'pending' AND task_id IN (
          SELECT id FROM agent_runs WHERE status IN ('preparing', 'running', 'awaiting_approval')
        )
      `).run().changes;
      this.db.query(`
        UPDATE sessions SET status = 'interrupted', updated_at = ?
        WHERE id IN (SELECT session_id FROM agent_runs WHERE status IN ('preparing', 'running', 'awaiting_approval'))
      `).run(new Date().toISOString());
      runs = this.db.query(`
        UPDATE agent_runs SET status = 'interrupted', error = 'sidecar_restarted', completed_at = ?
        WHERE status IN ('preparing', 'running', 'awaiting_approval')
      `).run(new Date().toISOString()).changes;
    })();
    return { runs, approvals };
  }

  async run(
    input: { sessionId: string; runtimeKind: string; prompt: string; attachmentIds?: string[]; workspaceRefIds?: string[]; signal?: AbortSignal; runtimeOptions?: Record<string, unknown> },
    emit: (event: RuntimeEvent) => void | Promise<void> = () => {},
  ): Promise<AgentRunResult> {
    const session = this.db.query<SessionRow, [string]>("SELECT id, mode, workspace_id, status FROM sessions WHERE id = ?").get(input.sessionId);
    if (!session) throw new Error("session_not_found");
    if (session.mode !== "single_agent") throw new Error("single_agent_session_required");
    if (!session.workspace_id) throw new Error("single_agent_workspace_required");
    if (!["idle", "completed", "failed", "cancelled", "interrupted"].includes(session.status)) throw new Error("session_already_running");
    const agent = this.db.query<AgentRow, [string]>("SELECT agent_id FROM session_agents WHERE session_id = ? ORDER BY position LIMIT 1").get(session.id);
    if (!agent) throw new Error("single_agent_missing_agent");
    const attachmentRecords = (input.attachmentIds ?? []).map((attachmentId) => {
      const attachment = this.attachments.get(attachmentId);
      if (!attachment || attachment.status !== "ready" || !this.attachments.belongsToWorkspace(attachmentId, session.workspace_id!)) throw new Error("attachment_not_found");
      return attachment;
    });
    if (attachmentRecords.length > 10) throw new Error("attachment_count_exceeded");
    if (attachmentRecords.reduce((total, attachment) => total + attachment.byteSize, 0) > 50 * 1024 * 1024) {
      throw new Error("attachment_batch_too_large");
    }
    const workspaceRefs = (input.workspaceRefIds ?? []).map((refId) => {
      const reference = this.db.query<WorkspaceRefRow, [string]>("SELECT id, workspace_id, relative_path, snapshot_hash FROM workspace_refs WHERE id = ?").get(refId);
      if (!reference || reference.workspace_id !== session.workspace_id) throw new Error("workspace_ref_not_found");
      return reference;
    });
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const startedEvent: RuntimeEvent = { type: "extension", name: "run_started", payload: { runId } };
    const userMessageId = crypto.randomUUID();
    const parts: MessagePart[] = [];
    for (const attachment of attachmentRecords) {
      const attachmentId = attachment.id;
      const part: MessagePart = attachment.mediaType.startsWith("image/")
        ? { type: "image", attachmentId, mediaType: attachment.mediaType }
        : { type: "file", attachmentId, mediaType: attachment.mediaType, filename: attachment.filename };
      parts.push(part);
    }
    for (const reference of workspaceRefs) {
      parts.push({ type: "workspace_ref", refId: reference.id, relativePath: reference.relative_path, snapshotHash: reference.snapshot_hash ?? undefined });
    }
    this.db.transaction(() => {
      this.db.query("INSERT INTO agent_runs (id, session_id, prompt, status, created_at) VALUES (?, ?, ?, 'preparing', ?)").run(runId, session.id, input.prompt, now);
      this.events.appendInTransaction({ eventId: `run-started:${runId}`, sessionId: session.id, taskId: runId, type: "run.started", payload: { runId } });
      this.db.query("INSERT INTO session_messages (id, session_id, role, content, status, created_at) VALUES (?, ?, 'user', ?, 'completed', ?)")
        .run(userMessageId, session.id, input.prompt, now);
      this.db.query("INSERT INTO message_parts (id, message_id, ordinal, type, text) VALUES (?, ?, 0, 'text', ?)").run(crypto.randomUUID(), userMessageId, input.prompt);
      for (const [index, attachment] of attachmentRecords.entries()) {
        const attachmentId = attachment.id;
        const part = parts[index]!;
        this.db.query("INSERT INTO message_parts (id, message_id, ordinal, type, attachment_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?)")
          .run(crypto.randomUUID(), userMessageId, index + 1, part.type, attachmentId, JSON.stringify({ mediaType: attachment.mediaType, filename: attachment.filename }));
        this.db.query("INSERT INTO message_attachments (message_id, attachment_id, ordinal) VALUES (?, ?, ?)").run(userMessageId, attachmentId, index);
      }
      for (const [index, reference] of workspaceRefs.entries()) {
        const ordinal = attachmentRecords.length + index + 1;
        this.db.query("INSERT INTO message_parts (id, message_id, ordinal, type, metadata_json) VALUES (?, ?, ?, 'workspace_ref', ?)")
          .run(crypto.randomUUID(), userMessageId, ordinal, JSON.stringify({ refId: reference.id, relativePath: reference.relative_path, snapshotHash: reference.snapshot_hash }));
      }
      this.db.query("UPDATE sessions SET status = 'running', updated_at = ? WHERE id = ?").run(now, session.id);
    })();

    let runtimeSessionId = "";
    let assistantText = "";
    let usageIndex = 0;
    try {
      await emit(startedEvent);
      const handle = await this.runtimes.open({
        runtimeKind: input.runtimeKind,
        agentSessionId: `${session.id}:${agent.agent_id}:${runId}`,
        sessionId: session.id,
        agentId: agent.agent_id,
        workspaceId: session.workspace_id,
        runtimeOptions: input.runtimeOptions,
      });
      runtimeSessionId = handle.id;
      this.db.query("UPDATE agent_runs SET runtime_session_id = ?, status = 'running' WHERE id = ?").run(handle.id, runId);
      const active: ActiveRun = { runtimeSessionId: handle.id, calls: new Map(), cancelled: false };
      this.active.set(runId, active);
      await this.runtimes.run(handle.id, {
        taskId: runId,
        prompt: input.prompt,
        parts,
        signal: input.signal,
        onEvent: async (event) => {
          if (event.type === "tool_call") active.calls.set(event.callId, { name: event.name, input: event.input });
          if (event.type === "approval_required") {
            const call = active.calls.get(event.callId);
            if (!call) throw new Error("approval_without_tool_call");
            const workspace = this.db.query<WorkspaceRow, [string]>("SELECT identity_hash FROM workspaces WHERE id = ?").get(session.workspace_id!);
            if (!workspace) throw new Error("workspace_not_found");
            const approval = this.approvals.request({
              taskId: runId,
              kind: event.kind ?? (call.name === "file_change" ? "file_change" : "command_execution"),
              subjectId: `${runId}:${event.requestId}`,
              inputHash: hashToolInput(call.input),
              workspaceIdentity: workspace.identity_hash,
              attemptId: runId,
              policyVersion: 1,
              risk: event.risk ?? (call.name === "file_change" ? "high" : "medium"),
              freshHumanRequired: call.name === "file_change" || event.risk === "high" || event.risk === "destructive",
            });
            this.db.query("UPDATE agent_runs SET status = 'awaiting_approval' WHERE id = ?").run(runId);
            this.events.append({
              eventId: `approval:${approval.id}`,
              sessionId: session.id,
              taskId: runId,
              type: "approval.requested",
              payload: approval,
            });
            await emit({ ...event, requestId: approval.id });
            return;
          } else if (event.type === "text_delta") {
            assistantText += event.text;
          } else if (event.type === "usage") {
            this.usage.record({ stableKey: `single:${runId}:${usageIndex++}`, sessionId: session.id, taskId: runId, agentId: agent.agent_id, usage: event.usage });
          }
          await emit(event);
        },
      });
      const completedAt = new Date().toISOString();
      this.db.transaction(() => {
        this.db.query("UPDATE agent_runs SET status = 'completed', completed_at = ? WHERE id = ?").run(completedAt, runId);
        this.db.query("UPDATE sessions SET status = 'completed', updated_at = ? WHERE id = ?").run(completedAt, session.id);
        const assistantMessageId = crypto.randomUUID();
        this.db.query("INSERT INTO session_messages (id, session_id, role, author_id, content, status, created_at) VALUES (?, ?, 'assistant', ?, ?, 'completed', ?)")
          .run(assistantMessageId, session.id, agent.agent_id, assistantText, completedAt);
        this.db.query("INSERT INTO message_parts (id, message_id, ordinal, type, text) VALUES (?, ?, 0, 'text', ?)")
          .run(crypto.randomUUID(), assistantMessageId, assistantText);
      })();
      return { id: runId, sessionId: session.id, runtimeSessionId, status: "completed" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = input.signal?.aborted || this.active.get(runId)?.cancelled ? "cancelled" : "failed";
      const completedAt = new Date().toISOString();
      this.db.transaction(() => {
        this.db.query("UPDATE agent_runs SET status = ?, error = ?, completed_at = ? WHERE id = ?").run(status, message, completedAt, runId);
        this.db.query("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?").run(status, completedAt, session.id);
      })();
      return { id: runId, sessionId: session.id, runtimeSessionId, status, error: message };
    } finally {
      if (runtimeSessionId) await this.runtimes.close(runtimeSessionId);
      this.active.delete(runId);
    }
  }

  async decide(requestId: string, input: { clientDecisionKey: string; decision: ApprovalDecision; reason?: string }): Promise<DurableApprovalDecision> {
    const request = this.approvals.getRequest(requestId);
    if (!request) throw new Error("approval_request_not_found");
    if (request.status !== "pending") return this.approvals.decide(requestId, input);
    const separator = request.subjectId.indexOf(":");
    if (separator < 1) throw new Error("approval_subject_invalid");
    const runId = request.subjectId.slice(0, separator);
    const runtimeRequestId = request.subjectId.slice(separator + 1);
    const active = this.active.get(runId);
    if (!active) throw new Error("agent_run_not_active");
    const decision = this.approvals.decide(requestId, input);
    await this.runtimes.answerApproval(active.runtimeSessionId, runtimeRequestId, input.decision);
    this.db.query("UPDATE agent_runs SET status = 'running' WHERE id = ?").run(runId);
    const run = this.db.query<{ session_id: string }, [string]>("SELECT session_id FROM agent_runs WHERE id = ?").get(runId);
    if (run) this.events.append({
      eventId: `approval-decision:${decision.id}`,
      sessionId: run.session_id,
      taskId: runId,
      type: "approval.decided",
      payload: decision,
    });
    return decision;
  }

  async cancel(runId: string): Promise<void> {
    const active = this.active.get(runId);
    if (!active) throw new Error("agent_run_not_active");
    active.cancelled = true;
    await this.runtimes.interrupt(active.runtimeSessionId);
  }
}
