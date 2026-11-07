import { ensureColumns, migrationChecksum, type Migration } from "../migrations";

/** Old grants remain facts; only new explicitly scoped requests are reusable. */
export const sessionToolApprovalsMigration: Migration = {
  version: 25,
  name: "session_tool_approval_scope",
  checksum: migrationChecksum("025:approval-requests:session-id:tool-generation:scope-index:v1"),
  up(db) {
    ensureColumns(db, "approval_requests", ["session_id TEXT", "tool_generation INTEGER"]);
    db.exec("CREATE INDEX IF NOT EXISTS idx_approval_session_scope ON approval_requests(session_id,workspace_identity,kind,policy_version,tool_generation,status)");
  },
};
