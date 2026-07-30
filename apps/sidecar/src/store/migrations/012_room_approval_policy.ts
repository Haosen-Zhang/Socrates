import type { Migration } from "../migrations";
import { ensureColumns, migrationChecksum } from "../migrations";

export const roomApprovalPolicyMigration: Migration = {
  version: 12,
  name: "room_approval_policy",
  checksum: migrationChecksum("012:room-approval-policy:v1:mode-version"),
  up(db) {
    ensureColumns(db, "sessions", [
      "approval_policy TEXT NOT NULL DEFAULT 'ask'",
      "approval_policy_version INTEGER NOT NULL DEFAULT 1",
    ]);
    db.exec(`
      CREATE TRIGGER sessions_approval_policy_insert_guard
      BEFORE INSERT ON sessions
      WHEN NEW.approval_policy NOT IN ('ask', 'auto_safe', 'workspace_full')
      BEGIN
        SELECT RAISE(ABORT, 'invalid_approval_policy');
      END;
      CREATE TRIGGER sessions_approval_policy_update_guard
      BEFORE UPDATE OF approval_policy ON sessions
      WHEN NEW.approval_policy NOT IN ('ask', 'auto_safe', 'workspace_full')
      BEGIN
        SELECT RAISE(ABORT, 'invalid_approval_policy');
      END;
    `);
  },
};
