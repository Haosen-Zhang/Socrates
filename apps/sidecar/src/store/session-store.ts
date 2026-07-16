import type { Database } from "bun:sqlite";
import { validateConversation, type ConversationMode, type ConversationSession, type SessionAgentSnapshot } from "@socrates/core";

type SessionRow = {
  id: string;
  title: string;
  mode: ConversationMode;
  workspace_id: string | null;
  status: string;
  legacy_room_id: string | null;
  created_at: string;
  updated_at: string;
};

type AgentRow = { agent_id: string; snapshot_json: string; position: number; execution_eligible: number };

export class SessionStore {
  constructor(private readonly db: Database) {}

  create(input: {
    id?: string;
    title: string;
    mode: ConversationMode;
    workspaceId?: string | null;
    legacyRoomId?: string | null;
    agents: Array<{ agentId: string; snapshot: Record<string, unknown>; executionEligible: boolean }>;
  }): ConversationSession {
    const errors = validateConversation({ mode: input.mode, agentIds: input.agents.map((agent) => agent.agentId) });
    if (errors.length) throw new Error(errors[0]);
    if (new Set(input.agents.map((agent) => agent.agentId)).size !== input.agents.length) throw new Error("duplicate_session_agent");
    const id = input.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.query(`
        INSERT INTO sessions (id, title, mode, workspace_id, status, legacy_room_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'idle', ?, ?, ?)
      `).run(id, input.title.trim() || "Untitled", input.mode, input.workspaceId ?? null, input.legacyRoomId ?? null, now, now);
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
      workspaceId: row.workspace_id,
      status: row.status,
      legacyRoomId: row.legacy_room_id,
      agents,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
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
}
