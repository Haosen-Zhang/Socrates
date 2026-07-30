import type { Database } from "bun:sqlite";
import { validateConversation, type ConversationMode, type ConversationSession, type MessagePart, type SessionAgentSnapshot, type SessionMessage,
  type ToolOutputRef,
  type ToolApprovalMode,
  normalizeToolApprovalMode,
  type ConversationTurnStatus,
  validateRoomShape,
  type RoomKind,
  normalizeCollaborationSettings,
  DEFAULT_COLLABORATION_SETTINGS,
  resolveCollaborationDefaults,
  validateCollaborationSettings,
  type RoomCollaborationSettings,
} from "@socrates/core";

type SessionRow = {
  id: string;
  title: string;
  mode: ConversationMode;
  kind: RoomKind | null;
  collaboration_json: string | null;
  workspace_id: string | null;
  primary_agent_id: string | null;
  approval_policy: ToolApprovalMode;
  approval_policy_version: number;
  archived: number;
  status: string;
  legacy_room_id: string | null;
  created_at: string;
  updated_at: string;
};

type AgentRow = { agent_id: string; snapshot_json: string; position: number; execution_eligible: number };
type MessageRow = {
  id: string;
  session_id: string;
  role: SessionMessage["role"];
  author_id: string | null;
  kind: SessionMessage["kind"] | null;
  content: string;
  sequence: number | null;
  run_id: string | null;
  turn_id: string | null;
  turn_status: ConversationTurnStatus | null;
  status: string;
  created_at: string;
};
type PartRow = {
  type: string;
  text: string | null;
  attachment_id: string | null;
  tool_call_id: string | null;
  metadata_json: string | null;
};

export class SessionStore {
  constructor(private readonly db: Database) {}

  create(input: {
    id?: string;
    title: string;
    mode: ConversationMode;
    /** 新模型：chat | cowork。省略时由 legacy mode 推导，兼容旧调用方。 */
    kind?: RoomKind;
    workspaceId?: string | null;
    primaryAgentId: string;
    collaborationDefaults?: RoomCollaborationSettings;
    legacyRoomId?: string | null;
    agents: Array<{ agentId: string; snapshot: Record<string, unknown>; executionEligible: boolean }>;
  }): ConversationSession {
    const agentIds = input.agents.map((agent) => agent.agentId);
    const errors = validateConversation({ mode: input.mode, agentIds });
    if (errors.length) throw new Error(errors[0]);
    if (new Set(agentIds).size !== agentIds.length) throw new Error("duplicate_session_agent");
    const primaryAgentId = input.primaryAgentId;
    if (!primaryAgentId || !agentIds.includes(primaryAgentId)) throw new Error("primary_agent_must_be_room_member");
    // 房间形状由 core 统一裁决：chat 不得绑定 workspace，cowork 必须绑定
    const kind: RoomKind = input.kind ?? (input.mode === "chat" ? "chat" : "cowork");
    const workspaceId = kind === "chat" ? null : input.workspaceId ?? null;
    const shapeErrors = validateRoomShape({ kind, workspaceId, agentIds });
    if (shapeErrors.length) throw new Error(shapeErrors[0]);
    // 不得把房间绑到已归档的工作区——否则它在侧栏里无处安放（归档树里也不显示）
    if (workspaceId) {
      const workspace = this.db.query<{ archived: number }, [string]>("SELECT archived FROM workspaces WHERE id = ?").get(workspaceId);
      if (!workspace) throw new Error("workspace_not_found");
      if (workspace.archived === 1) throw new Error("workspace_archived");
    }
    const id = input.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    // cowork 房间落一份默认协作设置：多成员默认轮流讨论，单成员默认不讨论——
    // 这样 UI 显示的默认与运行时一致，而不是留空让两边各自推断。
    const collaborationJson = kind === "cowork"
      ? JSON.stringify(resolveCollaborationDefaults(
          input.collaborationDefaults ?? DEFAULT_COLLABORATION_SETTINGS,
          { kind, workspaceId, agentIds, primaryAgentId },
          primaryAgentId,
        ))
      : null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.query(`
        INSERT INTO sessions
          (id, title, mode, kind, workspace_id, primary_agent_id, collaboration_json,
           archived, status, legacy_room_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'idle', ?, ?, ?)
      `).run(
        id,
        input.title.trim() || "Untitled",
        input.mode,
        kind,
        workspaceId,
        primaryAgentId,
        collaborationJson,
        input.legacyRoomId ?? null,
        now,
        now,
      );
      const insertAgent = this.db.query(`
        INSERT INTO session_agents (session_id, agent_id, snapshot_json, position, execution_eligible)
        VALUES (?, ?, ?, ?, ?)
      `);
      input.agents.forEach((agent, position) => {
        insertAgent.run(id, agent.agentId, JSON.stringify(agent.snapshot), position, agent.executionEligible ? 1 : 0);
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const created = this.get(id);
    if (!created) throw new Error("session_create_failed");
    return created;
  }

  get(id: string): ConversationSession | null {
    const row = this.db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id);
    if (!row) return null;
    const agents: SessionAgentSnapshot[] = this.db.query<AgentRow, [string]>(
      "SELECT agent_id, snapshot_json, position, execution_eligible FROM session_agents WHERE session_id = ? ORDER BY position",
    ).all(id).map((agent) => ({
      agentId: agent.agent_id,
      snapshot: JSON.parse(agent.snapshot_json),
      position: agent.position,
      executionEligible: agent.execution_eligible === 1,
    }));
    if (!row.primary_agent_id) throw new Error("session_primary_agent_missing");
    return {
      id: row.id,
      title: row.title,
      mode: row.mode,
      kind: row.kind ?? (row.mode === "chat" ? "chat" : "cowork"),
      collaboration: normalizeCollaborationSettings(row.collaboration_json ? JSON.parse(row.collaboration_json) : null),
      approvalPolicy: {
        mode: normalizeToolApprovalMode(row.approval_policy),
        version: row.approval_policy_version,
      },
      workspaceId: row.workspace_id,
      primaryAgentId: row.primary_agent_id,
      archived: row.archived === 1,
      status: row.status,
      legacyRoomId: row.legacy_room_id,
      agents,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(): ConversationSession[] {
    return this.db.query<{ id: string }, []>("SELECT id FROM sessions ORDER BY archived, updated_at DESC").all()
      .map((row) => this.get(row.id)!)
      .filter(Boolean);
  }

  listMessages(sessionId: string): SessionMessage[] {
    return this.db.query<MessageRow, [string]>(`
      SELECT messages.*, turns.status AS turn_status
      FROM session_messages AS messages
      LEFT JOIN conversation_turns AS turns ON turns.id = messages.turn_id
      WHERE messages.session_id = ?
      ORDER BY COALESCE(messages.sequence, 2147483647), messages.created_at, messages.id
    `).all(sessionId).map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      authorId: row.author_id,
      kind: row.kind ?? (row.role === "tool" ? "tool_result" : "text"),
      content: row.content,
      sequence: row.sequence ?? Number.MAX_SAFE_INTEGER,
      runId: row.run_id,
      turnId: row.turn_id,
      turnStatus: row.turn_status,
      status: row.status,
      createdAt: row.created_at,
      parts: this.db.query<PartRow, [string]>("SELECT type, text, attachment_id, tool_call_id, metadata_json FROM message_parts WHERE message_id = ? ORDER BY ordinal").all(row.id).flatMap((part): MessagePart[] => {
        const metadata = part.metadata_json ? JSON.parse(part.metadata_json) as Record<string, unknown> : {};
        if (part.type === "text") return [{ type: "text", text: part.text ?? "" }];
        if (part.type === "reasoning_summary") return [{ type: "reasoning_summary", text: part.text ?? "" }];
        if (part.type === "image" && part.attachment_id) return [{ type: "image", attachmentId: part.attachment_id, mediaType: String(metadata.mediaType ?? "application/octet-stream"), alt: String(metadata.filename ?? "image") }];
        if (part.type === "file" && part.attachment_id) return [{ type: "file", attachmentId: part.attachment_id, mediaType: String(metadata.mediaType ?? "application/octet-stream"), filename: String(metadata.filename ?? "file") }];
        if (part.type === "workspace_ref") return [{ type: "workspace_ref", refId: String(metadata.refId ?? ""), relativePath: String(metadata.relativePath ?? ""), snapshotHash: typeof metadata.snapshotHash === "string" ? metadata.snapshotHash : undefined }];
        if (part.type === "tool_call" && part.tool_call_id) return [{
          type: "tool_call",
          callId: part.tool_call_id,
          name: String(metadata.name ?? ""),
          input: metadata.input,
        }];
        if (part.type === "tool_result" && part.tool_call_id) return [{
          type: "tool_result",
          callId: part.tool_call_id,
          output: metadata.output as ToolOutputRef,
          isError: metadata.isError === true,
        }];
        return [];
      }),
    }));
  }

  bindWorkspace(sessionId: string, workspaceId: string | null): ConversationSession {
    const session = this.get(sessionId);
    if (!session) throw new Error("session_not_found");
    if (!["idle", "completed", "failed", "cancelled", "interrupted"].includes(session.status)) {
      throw new Error("active_session_workspace_locked");
    }
    if (workspaceId) {
      const workspace = this.db.query<{ archived: number }, [string]>("SELECT archived FROM workspaces WHERE id = ?").get(workspaceId);
      if (!workspace) throw new Error("workspace_not_found");
      if (workspace.archived === 1) throw new Error("workspace_archived");
    }
    this.db.query("UPDATE sessions SET workspace_id = ?, updated_at = ? WHERE id = ?")
      .run(workspaceId, new Date().toISOString(), sessionId);
    return this.get(sessionId)!;
  }

  /** 更新协作设置；跨字段合法性由 core 统一裁决，非法直接拒绝（不静默回退） */
  updateCollaboration(
    sessionId: string,
    settings: RoomCollaborationSettings,
    primaryAgentId?: string,
  ): ConversationSession {
    const session = this.get(sessionId);
    if (!session) throw new Error("session_not_found");
    if (!SessionStore.INACTIVE.includes(session.status)) {
      throw new Error("active_session_collaboration_locked");
    }
    const nextPrimaryAgentId = primaryAgentId ?? session.primaryAgentId;
    const primary = session.agents.find((agent) => agent.agentId === nextPrimaryAgentId);
    if (!primary) throw new Error("primary_agent_must_be_room_member");
    if (!primary.executionEligible) throw new Error("primary_agent_must_be_execution_eligible");
    const normalized = normalizeCollaborationSettings(settings);
    const errors = validateCollaborationSettings(
      {
        kind: session.kind,
        workspaceId: session.workspaceId,
        agentIds: session.agents.map((agent) => agent.agentId),
        primaryAgentId: nextPrimaryAgentId,
      },
      normalized,
    );
    if (errors.length) throw new Error(errors[0]);
    this.db.query(`
      UPDATE sessions
      SET collaboration_json = ?, primary_agent_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify(normalized),
      nextPrimaryAgentId,
      new Date().toISOString(),
      sessionId,
    );
    return this.get(sessionId)!;
  }

  updatePrimaryAgent(sessionId: string, primaryAgentId: string): ConversationSession {
    const session = this.get(sessionId);
    if (!session) throw new Error("session_not_found");
    if (!SessionStore.INACTIVE.includes(session.status)) {
      throw new Error("active_session_primary_agent_locked");
    }
    const member = session.agents.find((agent) => agent.agentId === primaryAgentId);
    if (!member) throw new Error("primary_agent_must_be_room_member");
    if (!member.executionEligible) throw new Error("primary_agent_must_be_execution_eligible");
    this.db.query("UPDATE sessions SET primary_agent_id = ?, updated_at = ? WHERE id = ?")
      .run(primaryAgentId, new Date().toISOString(), sessionId);
    return this.get(sessionId)!;
  }

  restoreCollaborationDefaults(
    sessionId: string,
    defaults: RoomCollaborationSettings,
  ): ConversationSession {
    const session = this.get(sessionId);
    if (!session) throw new Error("session_not_found");
    return this.updateCollaboration(
      sessionId,
      resolveCollaborationDefaults(
        defaults,
        {
          kind: session.kind,
          workspaceId: session.workspaceId,
          agentIds: session.agents.map((agent) => agent.agentId),
          primaryAgentId: session.primaryAgentId,
        },
        session.primaryAgentId,
      ),
    );
  }

  updateApprovalPolicy(sessionId: string, mode: ToolApprovalMode): ConversationSession {
    const session = this.get(sessionId);
    if (!session) throw new Error("session_not_found");
    if (session.approvalPolicy.mode === mode) return session;
    this.db.query(`
      UPDATE sessions
      SET approval_policy = ?, approval_policy_version = approval_policy_version + 1, updated_at = ?
      WHERE id = ?
    `).run(mode, new Date().toISOString(), sessionId);
    return this.get(sessionId)!;
  }

  private static readonly INACTIVE = ["idle", "completed", "failed", "cancelled", "interrupted"];

  /** 会话人数变了，mode 随之重算：1 人 single_agent，≥2 人 multi_agent（chat 不变）。 */
  private syncMode(sessionId: string, kind: RoomKind, memberCount: number): void {
    if (kind === "chat") return;
    const mode = memberCount >= 2 ? "multi_agent" : "single_agent";
    this.db.query("UPDATE sessions SET mode = ? WHERE id = ?").run(mode, sessionId);
  }

  addAgent(sessionId: string, agentId: string, snapshot: Record<string, unknown>): ConversationSession {
    const session = this.get(sessionId);
    if (!session) throw new Error("session_not_found");
    if (!SessionStore.INACTIVE.includes(session.status)) throw new Error("active_session_members_locked");
    if (session.agents.some((agent) => agent.agentId === agentId)) throw new Error("session_agent_already_member");
    const position = session.agents.length;
    this.db.query("INSERT INTO session_agents (session_id, agent_id, snapshot_json, position, execution_eligible) VALUES (?, ?, ?, ?, 1)")
      .run(sessionId, agentId, JSON.stringify(snapshot), position);
    this.syncMode(sessionId, session.kind, session.agents.length + 1);
    this.db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), sessionId);
    return this.get(sessionId)!;
  }

  removeAgent(sessionId: string, agentId: string): ConversationSession {
    const session = this.get(sessionId);
    if (!session) throw new Error("session_not_found");
    if (!SessionStore.INACTIVE.includes(session.status)) throw new Error("active_session_members_locked");
    if (!session.agents.some((agent) => agent.agentId === agentId)) throw new Error("session_agent_not_member");
    if (session.agents.length <= 1) throw new Error("session_requires_at_least_one_member");
    let nextPrimaryAgentId = session.primaryAgentId;
    if (session.primaryAgentId === agentId) {
      const replacement = session.agents.find((agent) => agent.agentId !== agentId && agent.executionEligible)
        ?? session.agents.find((agent) => agent.agentId !== agentId);
      if (!replacement) throw new Error("primary_agent_replacement_required");
      nextPrimaryAgentId = replacement.agentId;
      this.db.query("UPDATE sessions SET primary_agent_id = ? WHERE id = ?").run(replacement.agentId, sessionId);
    }
    this.db.query("DELETE FROM session_agents WHERE session_id = ? AND agent_id = ?").run(sessionId, agentId);
    // 重排 position，保持连续（发言顺序等依赖它）
    this.get(sessionId)!.agents.forEach((agent, index) => {
      this.db.query("UPDATE session_agents SET position = ? WHERE session_id = ? AND agent_id = ?").run(index, sessionId, agent.agentId);
    });
    this.syncMode(sessionId, session.kind, session.agents.length - 1);
    const remainingAgentIds = session.agents
      .map((agent) => agent.agentId)
      .filter((id) => id !== agentId);
    const safeSettings = normalizeCollaborationSettings({
      ...session.collaboration,
      strategy: remainingAgentIds.length < 2 ? "single" : session.collaboration.strategy,
      discussion: {
        ...session.collaboration.discussion,
        enabled: remainingAgentIds.length >= 2 && session.collaboration.discussion.enabled,
      },
    });
    const reconciled = resolveCollaborationDefaults(
      safeSettings,
      {
        kind: session.kind,
        workspaceId: session.workspaceId,
        agentIds: remainingAgentIds,
        primaryAgentId: nextPrimaryAgentId,
      },
      nextPrimaryAgentId,
    );
    this.db.query("UPDATE sessions SET collaboration_json = ? WHERE id = ?")
      .run(JSON.stringify(reconciled), sessionId);
    this.db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), sessionId);
    return this.get(sessionId)!;
  }

  rename(sessionId: string, title: string): ConversationSession {
    const value = title.trim();
    if (!value) throw new Error("session_title_required");
    if (!this.get(sessionId)) throw new Error("session_not_found");
    this.db.query("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(value.slice(0, 120), new Date().toISOString(), sessionId);
    return this.get(sessionId)!;
  }

  archive(sessionId: string, archived: boolean): ConversationSession {
    const session = this.get(sessionId);
    if (!session) throw new Error("session_not_found");
    if (archived && !["idle", "completed", "failed", "cancelled", "interrupted"].includes(session.status)) {
      throw new Error("active_session_archive_locked");
    }
    this.db.query("UPDATE sessions SET archived = ?, updated_at = ? WHERE id = ?").run(archived ? 1 : 0, new Date().toISOString(), sessionId);
    return this.get(sessionId)!;
  }

  remove(sessionId: string, withinTransaction?: () => void): void {
    const session = this.get(sessionId);
    if (!session) throw new Error("session_not_found");
    if (!["idle", "completed", "failed", "cancelled", "interrupted"].includes(session.status)) throw new Error("active_session_delete_locked");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.query("DELETE FROM usage_records WHERE session_id = ?").run(sessionId);
      this.db.query("DELETE FROM multi_tasks WHERE session_id = ?").run(sessionId);
      this.db.query("DELETE FROM agent_runs WHERE session_id = ?").run(sessionId);
      this.db.query("DELETE FROM agent_sessions WHERE session_id = ?").run(sessionId);
      this.db.query("DELETE FROM task_events WHERE session_id = ?").run(sessionId);
      this.db.query("DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM session_messages WHERE session_id = ?)").run(sessionId);
      this.db.query("DELETE FROM message_parts WHERE message_id IN (SELECT id FROM session_messages WHERE session_id = ?)").run(sessionId);
      this.db.query("DELETE FROM session_messages WHERE session_id = ?").run(sessionId);
      this.db.query("DELETE FROM session_agents WHERE session_id = ?").run(sessionId);
      this.db.query("DELETE FROM sessions WHERE id = ?").run(sessionId);
      withinTransaction?.();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Context-only rewind: it never attempts to reverse workspace files or shell side effects. */
  rewind(sessionId: string, messageId: string): void {
    const session = this.get(sessionId);
    if (!session) throw new Error("session_not_found");
    if (!["idle", "completed", "failed", "cancelled", "interrupted"].includes(session.status)) throw new Error("active_session_rewind_locked");
    const target = this.db.query<{
      rid: number;
      created_at: string;
      thread_id: string | null;
      sequence: number | null;
    }, [string, string]>(
      "SELECT rowid AS rid, created_at, thread_id, sequence FROM session_messages WHERE id = ? AND session_id = ?",
    ).get(messageId, sessionId);
    if (!target) throw new Error("session_message_not_found");
    const sequenced = target.thread_id !== null && target.sequence !== null;
    const affected = sequenced
      ? this.db.query<{ id: string; run_id: string | null; turn_id: string | null }, [string, number]>(`
          SELECT id, run_id, turn_id
          FROM session_messages
          WHERE thread_id = ? AND sequence >= ?
          ORDER BY sequence
        `).all(target.thread_id!, target.sequence!)
      : [];
    const messageIds = affected.map((message) => message.id);
    const runIds = [...new Set(affected.flatMap((message) => message.run_id ? [message.run_id] : []))];
    const turnIds = [...new Set(affected.flatMap((message) => message.turn_id ? [message.turn_id] : []))];
    const marks = (values: string[]) => values.map(() => "?").join(",");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (sequenced) {
        if (runIds.length) {
          this.db.query(`DELETE FROM usage_records WHERE task_id IN (${marks(runIds)})`).run(...runIds);
          this.db.query(`DELETE FROM task_events WHERE task_id IN (${marks(runIds)})`).run(...runIds);
          this.db.query(`DELETE FROM tool_outputs WHERE tool_call_id IN (
            SELECT id FROM tool_calls WHERE task_id IN (${marks(runIds)})
          )`).run(...runIds);
          this.db.query(`DELETE FROM tool_calls WHERE task_id IN (${marks(runIds)})`).run(...runIds);
          this.db.query(`DELETE FROM agent_runs WHERE id IN (${marks(runIds)})`).run(...runIds);
        }
        if (messageIds.length) {
          this.db.query(`DELETE FROM message_attachments WHERE message_id IN (${marks(messageIds)})`).run(...messageIds);
          this.db.query(`DELETE FROM message_parts WHERE message_id IN (${marks(messageIds)})`).run(...messageIds);
          this.db.query(`DELETE FROM session_messages WHERE id IN (${marks(messageIds)})`).run(...messageIds);
        }
        if (turnIds.length) {
          const now = new Date().toISOString();
          this.db.query(`
            UPDATE conversation_turns
            SET status = 'interrupted', updated_at = ?, completed_at = ?
            WHERE id IN (${marks(turnIds)})
              AND EXISTS (
                SELECT 1 FROM session_messages
                WHERE session_messages.turn_id = conversation_turns.id
              )
          `).run(now, now, ...turnIds);
          this.db.query(`
            DELETE FROM conversation_turns
            WHERE id IN (${marks(turnIds)})
              AND NOT EXISTS (
                SELECT 1 FROM session_messages
                WHERE session_messages.turn_id = conversation_turns.id
              )
          `).run(...turnIds);
        }
        this.db.query(`
          UPDATE conversation_threads
          SET latest_sequence = COALESCE((
                SELECT MAX(sequence) FROM session_messages
                WHERE thread_id = conversation_threads.id
              ), 0),
              updated_at = ?
          WHERE id = ?
        `).run(new Date().toISOString(), target.thread_id!);
      } else {
        // Compatibility for pre-migration/unsequenced records.
        this.db.query("DELETE FROM usage_records WHERE session_id = ? AND created_at >= ?").run(sessionId, target.created_at);
        this.db.query("DELETE FROM multi_tasks WHERE session_id = ? AND created_at >= ?").run(sessionId, target.created_at);
        this.db.query("DELETE FROM agent_runs WHERE session_id = ? AND created_at >= ?").run(sessionId, target.created_at);
        this.db.query("DELETE FROM task_events WHERE session_id = ? AND occurred_at >= ?").run(sessionId, target.created_at);
        this.db.query("DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM session_messages WHERE session_id = ? AND rowid >= ?)").run(sessionId, target.rid);
        this.db.query("DELETE FROM message_parts WHERE message_id IN (SELECT id FROM session_messages WHERE session_id = ? AND rowid >= ?)").run(sessionId, target.rid);
        this.db.query("DELETE FROM session_messages WHERE session_id = ? AND rowid >= ?").run(sessionId, target.rid);
      }
      this.db.query("UPDATE sessions SET status = 'idle', updated_at = ? WHERE id = ?").run(new Date().toISOString(), sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
