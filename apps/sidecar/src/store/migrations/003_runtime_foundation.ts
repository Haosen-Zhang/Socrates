import type { Migration } from "../migrations";
import { migrationChecksum } from "../migrations";

export const runtimeFoundationMigration: Migration = {
  version: 3,
  name: "runtime_tool_permission_foundation",
  checksum: migrationChecksum("003:runtime_tool_permission_foundation:v1:tool-calls-outputs-rules-grants-runtime-sessions"),
  up(db) {
    db.exec(`
      CREATE TABLE tool_calls (
        id TEXT PRIMARY KEY, stable_key TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
        task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, turn_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        name TEXT NOT NULL, generation INTEGER NOT NULL, input_json TEXT NOT NULL, input_hash TEXT NOT NULL,
        workspace_identity TEXT NOT NULL, policy_version INTEGER NOT NULL,
        risk TEXT NOT NULL, idempotency TEXT NOT NULL, status TEXT NOT NULL,
        error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_tool_calls_task ON tool_calls (task_id, created_at);
      CREATE TABLE tool_outputs (
        tool_call_id TEXT PRIMARY KEY, preview_text TEXT NOT NULL, storage_key TEXT,
        sha256 TEXT, byte_size INTEGER NOT NULL, truncated INTEGER NOT NULL, is_error INTEGER NOT NULL,
        FOREIGN KEY (tool_call_id) REFERENCES tool_calls(id)
      );
      CREATE TABLE permission_rules (
        id TEXT PRIMARY KEY, scope_kind TEXT NOT NULL, scope_id TEXT, action TEXT NOT NULL,
        resource_pattern TEXT NOT NULL, effect TEXT NOT NULL, hard_deny INTEGER NOT NULL DEFAULT 0,
        priority INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL
      );
      CREATE TABLE permission_grants (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL, workspace_identity TEXT NOT NULL,
        subject_hash TEXT NOT NULL, scope TEXT NOT NULL, expires_at TEXT,
        FOREIGN KEY (request_id) REFERENCES approval_requests(id)
      );
      CREATE TABLE runtime_sessions (
        id TEXT PRIMARY KEY, agent_session_id TEXT NOT NULL, runtime_kind TEXT NOT NULL,
        external_id TEXT, protocol_version TEXT NOT NULL, binary_version TEXT,
        status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
  },
};
