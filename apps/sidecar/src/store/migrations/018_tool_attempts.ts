import { ensureColumns, migrationChecksum, type Migration } from "../migrations";

export const toolAttemptsMigration: Migration = {
  version: 18,
  name: "durable_tool_attempts",
  checksum: migrationChecksum("018:tool-attempts:v1:operation-scope-error-recovery-attempts"),
  up(db) {
    ensureColumns(db, "tool_calls", ["step_id TEXT", "capability TEXT", "error_detail_json TEXT", "recovery_disposition TEXT"]);
    db.exec(`CREATE TABLE tool_attempts (
      id TEXT PRIMARY KEY,
      tool_operation_id TEXT NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
      attempt_no INTEGER NOT NULL,
      status TEXT NOT NULL,
      error_json TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(tool_operation_id, attempt_no)
    )`);
  },
};
