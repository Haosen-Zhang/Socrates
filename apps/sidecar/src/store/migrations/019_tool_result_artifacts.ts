import { ensureColumns, migrationChecksum, type Migration } from "../migrations";

export const toolResultArtifactsMigration: Migration = {
  version: 19, name: "canonical_tool_results_and_artifacts",
  checksum: migrationChecksum("019:tool-output-canonical-storage:scoped-chunk-artifacts:v1"),
  up(db) {
    ensureColumns(db, "tool_outputs", ["canonical_json TEXT", "storage_key TEXT"]);
    db.exec(`CREATE TABLE tool_result_artifacts (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, workspace_identity TEXT NOT NULL,
      tool_operation_id TEXT, media_type TEXT NOT NULL, byte_size INTEGER NOT NULL DEFAULT 0,
      complete INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE tool_result_chunks (
      artifact_id TEXT NOT NULL REFERENCES tool_result_artifacts(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL, byte_offset INTEGER NOT NULL, byte_size INTEGER NOT NULL, bytes BLOB NOT NULL,
      PRIMARY KEY (artifact_id, ordinal)
    );
    CREATE INDEX tool_result_artifacts_scope ON tool_result_artifacts(session_id, workspace_identity);`);
  },
};
