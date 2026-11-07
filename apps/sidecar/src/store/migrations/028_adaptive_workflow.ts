import { migrationChecksum, type Migration } from "../migrations";

/** Domain facts are separate from LangGraph's opaque control checkpoints. */
export const adaptiveWorkflowMigration: Migration = {
  version: 28, name: "adaptive_workflow",
  checksum: migrationChecksum("028:adaptive-workflow:root-attempts-approvals-idempotent-actions:1"),
  up(db) {
    db.exec(`CREATE TABLE adaptive_workflows (
      root_task_id TEXT PRIMARY KEY REFERENCES room_commands(id) ON DELETE CASCADE,
      room_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      decision_id TEXT NOT NULL, status TEXT NOT NULL, state_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE adaptive_attempts (
      id TEXT PRIMARY KEY, root_task_id TEXT NOT NULL REFERENCES adaptive_workflows(root_task_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL, status TEXT NOT NULL, attempt_json TEXT NOT NULL,
      UNIQUE(root_task_id,ordinal)
    );
    CREATE TABLE adaptive_approvals (
      id TEXT PRIMARY KEY, root_task_id TEXT NOT NULL REFERENCES adaptive_workflows(root_task_id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL REFERENCES adaptive_attempts(id) ON DELETE CASCADE,
      status TEXT NOT NULL, approval_json TEXT NOT NULL, UNIQUE(attempt_id)
    );
    CREATE TABLE adaptive_requests (
      root_task_id TEXT NOT NULL REFERENCES adaptive_workflows(root_task_id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL,
      PRIMARY KEY(root_task_id,request_id)
    );
    CREATE INDEX adaptive_workflows_room ON adaptive_workflows(room_id,status);`);
  },
};
