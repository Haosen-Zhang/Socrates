import type { Database } from "bun:sqlite";
import { validateConversation, type ConversationMode, type ConversationSession, type MessagePart, type SessionAgentSnapshot, type SessionMessage,
  validateRoomShape,
  type RoomKind,
} from "@socrates/core";

type SessionRow = {
  id: string;
  title: string;
  mode: ConversationMode;
  kind: RoomKind | null;
  workspace_id: string | null;
  archived: number;
  status: string;
  legacy_room_id: string | null;
  created_at: string;
  updated_at: string;
};

type AgentRow = { agent_id: string; snapshot_json: string; position: number; execution_eligible: number };
type MessageRow = { id: string; session_id: string; role: SessionMessage["role"]; author_id: string | null; content: string; status: string; created_at: string };
type PartRow = { type: string; text: string | null; attachment_id: string | null; metadata_json: string | null };

export class SessionStore {
  constructor(private readonly db: Database) {}

  create(input: {
    id?: string;
    title: string;
    mode: ConversationMode;
    /** 新模型：chat | cowork。省略时由 legacy mode 推导，兼容旧调用方。 */
    kind?: RoomKind;
    workspaceId?: string | null;
    legacyRoomId?: string | null;
    agents: Array<{ agentId: string; snapshot: Record<string, unknown>; executionEligible: boolean }>;
  }): ConversationSession {
    const agentIds = input.agents.map((agent) => agent.agentId);
    const errors = validateConversation({ mode: input.mode, agentIds });
    if (errors.length) throw new Error(errors[0]);
    if (new Set(agentIds).size !== agentIds.length) throw new Error("duplicate_session_agent");
    // 房间形状由 core 统一裁决：chat 不得绑定 workspace，cowork 必须绑定
    const kind: RoomKind = input.kind ?? (input.mode === "chat" ? "chat" : "cowork");
    const workspaceId = kind === "chat" ? null : input.workspaceId ?? null;
    const shapeErrors = validateRoomShape({ kind, workspaceId, agentIds });
    if (shapeErrors.length) throw new Error(shapeErrors[0]);
    const id = input.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.query(`
        INSERT INTO sessions (id, title, mode, kind, workspace_id, archived, status, legacy_room_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, 'idle', ?, ?, ?)
      `).run(id, input.title.trim() || "Untitled", input.mode, kind, workspaceId, input.legacyRoomId ?? null, now, now);
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
    return {
      id: row.id,
      title: row.title,
      mode: row.mode,
      kind: row.kind ?? (row.mode === "chat" ? "chat" : "cowork"),
      workspaceId: row.workspace_id,
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
    return this.db.query<MessageRow, [string]>("SELECT * FROM session_messages WHERE session_id = ? ORDER BY created_at, id").all(sessionId).map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      authorId: row.author_id,
      content: row.content,
      status: row.status,
      createdAt: row.created_at,
      parts: this.db.query<PartRow, [string]>("SELECT type, text, attachment_id, metadata_json FROM message_parts WHERE message_id = ? ORDER BY ordinal").all(row.id).flatMap((part): MessagePart[] => {
        const metadata = part.metadata_json ? JSON.parse(part.metadata_json) as Record<string, unknown> : {};
        if (part.type === "text") return [{ type: "text", text: part.text ?? "" }];
        if (part.type === "image" && part.attachment_id) return [{ type: "image", attachmentId: part.attachment_id, mediaType: String(metadata.mediaType ?? "application/octet-stream"), alt: String(metadata.filename ?? "image") }];
        if (part.type === "file" && part.attachment_id) return [{ type: "file", attachmentId: part.attachment_id, mediaType: String(metadata.mediaType ?? "application/octet-stream"), filename: String(metadata.filename ?? "file") }];
        if (part.type === "workspace_ref") return [{ type: "workspace_ref", refId: String(metadata.refId ?? ""), relativePath: String(metadata.relativePath ?? ""), snapshotHash: typeof metadata.snapshotHash === "string" ? metadata.snapshotHash : undefined }];
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
    this.db.query("UPDATE sessions SET workspace_id = ?, updated_at = ? WHERE id = ?")
      .run(workspaceId, new Date().toISOString(), sessionId);
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

  remove(sessionId: string): void {
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
    const target = this.db.query<{ rid: number; created_at: string }, [string, string]>(
      "SELECT rowid AS rid, created_at FROM session_messages WHERE id = ? AND session_id = ?",
    ).get(messageId, sessionId);
    if (!target) throw new Error("session_message_not_found");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.query("DELETE FROM usage_records WHERE session_id = ? AND created_at >= ?").run(sessionId, target.created_at);
      this.db.query("DELETE FROM multi_tasks WHERE session_id = ? AND created_at >= ?").run(sessionId, target.created_at);
      this.db.query("DELETE FROM agent_runs WHERE session_id = ? AND created_at >= ?").run(sessionId, target.created_at);
      this.db.query("DELETE FROM task_events WHERE session_id = ? AND occurred_at >= ?").run(sessionId, target.created_at);
      this.db.query("DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM session_messages WHERE session_id = ? AND rowid >= ?)").run(sessionId, target.rid);
      this.db.query("DELETE FROM message_parts WHERE message_id IN (SELECT id FROM session_messages WHERE session_id = ? AND rowid >= ?)").run(sessionId, target.rid);
      this.db.query("DELETE FROM session_messages WHERE session_id = ? AND rowid >= ?").run(sessionId, target.rid);
      this.db.query("UPDATE sessions SET status = 'idle', updated_at = ? WHERE id = ?").run(new Date().toISOString(), sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
