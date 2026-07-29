import type { Database } from "bun:sqlite";
import type { ApprovalDecision, MessagePart, RuntimeEvent } from "@socrates/core";
import type { ApprovalManager, DurableApprovalDecision } from "../approvals/manager";
import { hashToolInput } from "../tools/executor";
import type { RuntimeManager } from "./runtime-manager";
import type { EventStore } from "../store/event-store";
import type { AttachmentResolver } from "../attachments/resolver";
import { UsageCollector } from "../services/usage-collector";
import { ConversationMemoryStore } from "../store/conversation-memory-store";
import { buildConversationContext } from "../services/conversation-context";

type SessionRow = {
  id: string;
  mode: string;
  workspace_id: string | null;
  primary_agent_id: string | null;
  status: string;
};
type WorkspaceRow = { identity_hash: string };
type AgentRow = { agent_id: string; snapshot_json: string };
type WorkspaceRefRow = { id: string; workspace_id: string; relative_path: string; snapshot_hash: string | null };
type ActiveRun = {
  runtimeSessionId: string;
  turnId: string;
  calls: Map<string, { name: string; input: unknown }>;
  cancelled: boolean;
};

export interface AgentRunResult {
  id: string;
  sessionId: string;
  runtimeSessionId: string;
  threadId: string;
  turnId: string;
  status: "completed" | "failed" | "cancelled";
  error?: string;
}

export class SingleAgentRunner {
  private readonly active = new Map<string, ActiveRun>();
  private readonly usage: UsageCollector;
  private readonly memory: ConversationMemoryStore;

  constructor(
    private readonly db: Database,
    private readonly runtimes: RuntimeManager,
    private readonly approvals: ApprovalManager,
    private readonly events: EventStore,
    private readonly attachments: AttachmentResolver,
  ) {
    this.usage = new UsageCollector(db);
    this.memory = new ConversationMemoryStore(db);
  }

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
      this.db.query(`
        UPDATE conversation_turns SET status = 'interrupted', updated_at = ?, completed_at = ?
        WHERE status IN ('preparing', 'running', 'awaiting_approval')
      `).run(new Date().toISOString(), new Date().toISOString());
    })();
    return { runs, approvals };
  }

  async run(
    input: {
      sessionId: string;
      runtimeKind: string;
      prompt: string;
      threadId?: string;
      clientTurnKey?: string;
      attachmentIds?: string[];
      workspaceRefIds?: string[];
      signal?: AbortSignal;
      runtimeOptions?: Record<string, unknown>;
    },
    emit: (event: RuntimeEvent) => void | Promise<void> = () => {},
  ): Promise<AgentRunResult> {
    const session = this.db.query<SessionRow, [string]>(
      "SELECT id, mode, workspace_id, primary_agent_id, status FROM sessions WHERE id = ?",
    ).get(input.sessionId);
    if (!session) throw new Error("session_not_found");
    if (session.mode !== "single_agent") throw new Error("single_agent_session_required");
    if (!session.workspace_id) throw new Error("single_agent_workspace_required");
    if (!["idle", "completed", "failed", "cancelled", "interrupted"].includes(session.status)) throw new Error("session_already_running");
    if (!session.primary_agent_id) throw new Error("single_agent_missing_primary_agent");
    const agent = this.db.query<AgentRow, [string, string]>(`
      SELECT agent_id, snapshot_json
      FROM session_agents
      WHERE session_id = ? AND agent_id = ?
    `).get(session.id, session.primary_agent_id);
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
    const thread = input.threadId
      ? this.memory.getThread(input.threadId)
      : this.memory.ensureDefaultThread(session.id);
    if (!thread || thread.roomId !== session.id) throw new Error("conversation_thread_not_found");
    const runId = crypto.randomUUID();
    const clientTurnKey = input.clientTurnKey ?? crypto.randomUUID();
    const prepared = this.memory.beginTurn({
      roomId: session.id,
      threadId: thread.id,
      clientTurnKey,
      inputHash: hashToolInput({
        prompt: input.prompt,
        attachmentIds: input.attachmentIds ?? [],
        workspaceRefIds: input.workspaceRefIds ?? [],
      }),
      runId,
      agentId: agent.agent_id,
      prompt: input.prompt,
      parts,
    });
    const startedEvent: RuntimeEvent = {
      type: "extension",
      name: "run_started",
      payload: {
        runId: prepared.runId,
        turnId: prepared.turnId,
        threadId: prepared.threadId,
        replayed: prepared.replayed,
      },
    };
    if (prepared.replayed) {
      await emit(startedEvent);
      const previous = this.db.query<{ runtime_session_id: string | null }, [string]>(
        "SELECT runtime_session_id FROM agent_runs WHERE id = ?",
      ).get(prepared.runId);
      return {
        id: prepared.runId,
        sessionId: session.id,
        runtimeSessionId: previous?.runtime_session_id ?? "",
        threadId: prepared.threadId,
        turnId: prepared.turnId,
        status: "completed",
      };
    }
    this.events.append({
      eventId: `run-started:${prepared.runId}`,
      sessionId: session.id,
      taskId: prepared.runId,
      type: "run.started",
      payload: {
        runId: prepared.runId,
        turnId: prepared.turnId,
        threadId: prepared.threadId,
        attemptNo: prepared.attemptNo,
      },
    });
    const history = await this.memory.listThreadMessages(prepared.threadId);
    const snapshot = JSON.parse(agent.snapshot_json) as Record<string, unknown>;
    const capabilities = snapshot.modelCapabilities && typeof snapshot.modelCapabilities === "object"
      ? snapshot.modelCapabilities as Record<string, unknown>
      : {};
    const configuredWindow = input.runtimeOptions?.contextWindowTokens
      ?? capabilities.contextWindowTokens
      ?? snapshot.contextWindowTokens;
    const contextWindowTokens = typeof configuredWindow === "number" && Number.isFinite(configuredWindow)
      ? Math.max(1_024, Math.floor(configuredWindow))
      : 32_768;
    const configuredOutput = input.runtimeOptions?.maxOutputTokens;
    const outputReserveTokens = typeof configuredOutput === "number" && Number.isFinite(configuredOutput)
      ? Math.max(256, Math.floor(configuredOutput))
      : Math.min(4_096, Math.floor(contextWindowTokens * 0.2));
    const instructionText = [snapshot.role, snapshot.systemPrompt].filter((value) => typeof value === "string").join("\n\n");
    const context = buildConversationContext(history, {
      contextWindowTokens,
      outputReserveTokens,
      instructionTokens: Math.ceil(new TextEncoder().encode(instructionText).byteLength / 4),
    });
    this.memory.updateTurnStatus(prepared.turnId, "preparing", {
      contextTruncated: context.truncated,
      context: {
        estimatedTokens: context.estimatedTokens,
        budgetTokens: context.budgetTokens,
        droppedThroughSequence: context.droppedThroughSequence,
      },
    });
    if (context.truncated) {
      this.events.append({
        eventId: `context-truncated:${prepared.runId}`,
        sessionId: session.id,
        taskId: prepared.runId,
        type: "memory.context_truncated",
        payload: {
          threadId: prepared.threadId,
          turnId: prepared.turnId,
          estimatedTokens: context.estimatedTokens,
          budgetTokens: context.budgetTokens,
          droppedThroughSequence: context.droppedThroughSequence,
        },
      });
    }

    let runtimeSessionId = "";
    let assistantText = "";
    let usageIndex = 0;
    try {
      await emit(startedEvent);
      const handle = await this.runtimes.open({
        runtimeKind: input.runtimeKind,
        agentSessionId: `${session.id}:${agent.agent_id}:${prepared.turnId}:${prepared.attemptNo}`,
        sessionId: session.id,
        agentId: agent.agent_id,
        workspaceId: session.workspace_id,
        runtimeOptions: input.runtimeOptions,
      });
      runtimeSessionId = handle.id;
      this.db.query("UPDATE agent_runs SET runtime_session_id = ?, status = 'running' WHERE id = ?")
        .run(handle.id, prepared.runId);
      this.db.query("UPDATE sessions SET status = 'running', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), session.id);
      this.memory.updateTurnStatus(prepared.turnId, "running");
      const active: ActiveRun = {
        runtimeSessionId: handle.id,
        turnId: prepared.turnId,
        calls: new Map(),
        cancelled: false,
      };
      this.active.set(prepared.runId, active);
      await this.runtimes.run(handle.id, {
        taskId: prepared.runId,
        prompt: input.prompt,
        parts,
        messages: context.messages,
        signal: input.signal,
        onEvent: async (event) => {
          if (event.type === "tool_call") {
            active.calls.set(event.callId, { name: event.name, input: event.input });
            await this.memory.appendMessage({
              roomId: session.id,
              threadId: prepared.threadId,
              runId: prepared.runId,
              turnId: prepared.turnId,
              agentId: agent.agent_id,
              role: "assistant",
              kind: "tool_call",
              content: "",
              parts: [{ type: "tool_call", callId: event.callId, name: event.name, input: event.input }],
              status: "completed",
              idempotencyKey: `tool-call:${prepared.runId}:${event.callId}`,
            });
          } else if (event.type === "tool_result") {
            await this.memory.appendMessage({
              roomId: session.id,
              threadId: prepared.threadId,
              runId: prepared.runId,
              turnId: prepared.turnId,
              agentId: agent.agent_id,
              role: "tool",
              kind: "tool_result",
              content: event.output.preview,
              parts: [{
                type: "tool_result",
                callId: event.callId,
                output: event.output,
                isError: event.isError,
              }],
              status: event.isError ? "failed" : "completed",
              idempotencyKey: `tool-result:${prepared.runId}:${event.callId}`,
            });
          }
          if (event.type === "approval_required") {
            const call = active.calls.get(event.callId);
            if (!call) throw new Error("approval_without_tool_call");
            const workspace = this.db.query<WorkspaceRow, [string]>("SELECT identity_hash FROM workspaces WHERE id = ?").get(session.workspace_id!);
            if (!workspace) throw new Error("workspace_not_found");
            const approval = this.approvals.request({
              taskId: prepared.runId,
              kind: event.kind ?? (call.name === "file_change" ? "file_change" : "command_execution"),
              subjectId: `${prepared.runId}:${event.requestId}`,
              inputHash: hashToolInput(call.input),
              workspaceIdentity: workspace.identity_hash,
              attemptId: prepared.runId,
              policyVersion: 1,
              risk: event.risk ?? (call.name === "file_change" ? "high" : "medium"),
              freshHumanRequired: call.name === "file_change" || event.risk === "high" || event.risk === "destructive",
            });
            this.db.query("UPDATE agent_runs SET status = 'awaiting_approval' WHERE id = ?").run(prepared.runId);
            this.memory.updateTurnStatus(prepared.turnId, "awaiting_approval");
            this.events.append({
              eventId: `approval:${approval.id}`,
              sessionId: session.id,
              taskId: prepared.runId,
              type: "approval.requested",
              payload: approval,
            });
            await emit({ ...event, requestId: approval.id });
            return;
          } else if (event.type === "text_delta") {
            assistantText += event.text;
          } else if (event.type === "usage") {
            this.usage.record({
              stableKey: `single:${prepared.runId}:${usageIndex++}`,
              sessionId: session.id,
              taskId: prepared.runId,
              agentId: agent.agent_id,
              usage: event.usage,
            });
          }
          await emit(event);
        },
      });
      const completedAt = new Date().toISOString();
      await this.memory.appendMessage({
        roomId: session.id,
        threadId: prepared.threadId,
        runId: prepared.runId,
        turnId: prepared.turnId,
        agentId: agent.agent_id,
        role: "assistant",
        kind: "text",
        content: assistantText,
        parts: [{ type: "text", text: assistantText }],
        status: "completed",
        idempotencyKey: `assistant-final:${prepared.turnId}`,
        createdAt: completedAt,
      });
      this.db.transaction(() => {
        this.db.query("UPDATE agent_runs SET status = 'completed', completed_at = ? WHERE id = ?")
          .run(completedAt, prepared.runId);
        this.db.query("UPDATE sessions SET status = 'completed', updated_at = ? WHERE id = ?").run(completedAt, session.id);
        this.db.query(`
          UPDATE conversation_turns
          SET status = 'completed', updated_at = ?, completed_at = ?
          WHERE id = ?
        `).run(completedAt, completedAt, prepared.turnId);
      })();
      return {
        id: prepared.runId,
        sessionId: session.id,
        runtimeSessionId,
        threadId: prepared.threadId,
        turnId: prepared.turnId,
        status: "completed",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = input.signal?.aborted || this.active.get(prepared.runId)?.cancelled ? "cancelled" : "failed";
      const completedAt = new Date().toISOString();
      this.db.transaction(() => {
        this.db.query("UPDATE agent_runs SET status = ?, error = ?, completed_at = ? WHERE id = ?")
          .run(status, message, completedAt, prepared.runId);
        this.db.query("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?").run(status, completedAt, session.id);
        this.db.query(`
          UPDATE conversation_turns
          SET status = ?, updated_at = ?, completed_at = ?
          WHERE id = ?
        `).run(status, completedAt, completedAt, prepared.turnId);
      })();
      return {
        id: prepared.runId,
        sessionId: session.id,
        runtimeSessionId,
        threadId: prepared.threadId,
        turnId: prepared.turnId,
        status,
        error: message,
      };
    } finally {
      if (runtimeSessionId) await this.runtimes.close(runtimeSessionId);
      this.active.delete(prepared.runId);
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
    this.memory.updateTurnStatus(active.turnId, "running");
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
