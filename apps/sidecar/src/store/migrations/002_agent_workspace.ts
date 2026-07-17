import type { Migration } from "../migrations";
import { migrationChecksum } from "../migrations";

export const agentWorkspaceMigration: Migration = {
  version: 2,
  name: "agent_workspace_foundation",
  checksum: migrationChecksum("002:agent_workspace_foundation:v1:workspaces-sessions-agents-events-approvals-leases"),
  up(db) {
    db.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE, display_path TEXT NOT NULL,
        identity_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL, created_at TEXT NOT NULL, last_opened_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('chat', 'single_agent', 'multi_agent')),
        workspace_id TEXT, status TEXT NOT NULL DEFAULT 'idle', legacy_room_id TEXT UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      );
      CREATE INDEX idx_sessions_workspace ON sessions (workspace_id, updated_at);
      CREATE TABLE session_agents (
        session_id TEXT NOT NULL, agent_id TEXT NOT NULL, snapshot_json TEXT NOT NULL,
        position INTEGER NOT NULL, execution_eligible INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, agent_id), FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT NOT NULL, runtime_kind TEXT NOT NULL,
        runtime_session_ref TEXT, status TEXT NOT NULL, last_event_cursor INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
      CREATE INDEX idx_agent_sessions_session ON agent_sessions (session_id, agent_id, created_at);
      CREATE TABLE task_events (
        event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT, seq INTEGER NOT NULL,
        type TEXT NOT NULL, payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL,
        UNIQUE (session_id, seq), FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
      CREATE INDEX idx_task_events_session_seq ON task_events (session_id, seq);
      CREATE TABLE approval_requests (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, subject_id TEXT NOT NULL,
        input_hash TEXT NOT NULL, workspace_identity TEXT NOT NULL, attempt_id TEXT NOT NULL,
        policy_version INTEGER NOT NULL, risk TEXT NOT NULL, fresh_human_required INTEGER NOT NULL,
        status TEXT NOT NULL, expires_at TEXT, created_at TEXT NOT NULL,
        UNIQUE (subject_id, input_hash, workspace_identity, attempt_id, policy_version)
      );
      CREATE TABLE approval_decisions (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL, client_decision_key TEXT NOT NULL UNIQUE,
        decision TEXT NOT NULL, decided_at TEXT NOT NULL, reason TEXT,
        FOREIGN KEY (request_id) REFERENCES approval_requests(id)
      );
      CREATE TABLE workspace_leases (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT NOT NULL, mode TEXT NOT NULL,
        owner_instance_id TEXT NOT NULL, expires_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      );
      CREATE UNIQUE INDEX idx_workspace_write_lease ON workspace_leases (workspace_id) WHERE mode = 'write';
    `);
    db.query("UPDATE tasks SET status = 'interrupted', error = COALESCE(error, 'interrupted_by_upgrade') WHERE status IN ('running', 'thinking')").run();
  },
};
