import type { Migration } from "../migrations";
import { migrationChecksum } from "../migrations";

export const p2ConversationMigration: Migration = {
  version: 4,
  name: "p2_conversations_and_attachments",
  checksum: migrationChecksum("004:p2-conversations:v2:agent-runs-session-messages-parts-attachments-sources-workspace-refs"),
  up(db) {
    db.exec(`
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, runtime_session_id TEXT,
        prompt TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
        created_at TEXT NOT NULL, completed_at TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
      CREATE INDEX idx_agent_runs_session ON agent_runs (session_id, created_at);
      CREATE TABLE session_messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
        author_id TEXT, content TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
        created_at TEXT NOT NULL, FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
      CREATE INDEX idx_session_messages_session ON session_messages (session_id, created_at);
      CREATE TABLE message_parts (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        type TEXT NOT NULL, text TEXT, attachment_id TEXT, tool_call_id TEXT, metadata_json TEXT,
        UNIQUE (message_id, ordinal)
      );
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, media_type TEXT NOT NULL,
        filename TEXT NOT NULL, byte_size INTEGER NOT NULL, storage_key TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (sha256, byte_size)
      );
      CREATE TABLE message_attachments (
        message_id TEXT NOT NULL, attachment_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        PRIMARY KEY (message_id, attachment_id), FOREIGN KEY (attachment_id) REFERENCES attachments(id)
      );
      CREATE TABLE attachment_sources (
        attachment_id TEXT NOT NULL, workspace_id TEXT NOT NULL, relative_path TEXT NOT NULL,
        PRIMARY KEY (attachment_id, workspace_id, relative_path),
        FOREIGN KEY (attachment_id) REFERENCES attachments(id), FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      );
      CREATE TABLE workspace_refs (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, relative_path TEXT NOT NULL,
        kind TEXT NOT NULL, snapshot_hash TEXT, snapshot_size INTEGER,
        created_at TEXT NOT NULL, FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
        UNIQUE (workspace_id, relative_path)
      );
    `);
  },
};
