import type { Migration } from "../migrations";
import { ensureColumns, migrationChecksum } from "../migrations";

export const managedWorkspacesMigration: Migration = {
  version: 13,
  name: "managed_workspaces",
  checksum: migrationChecksum("013:managed-workspaces:v1:ownership-owner-session"),
  up(db) {
    ensureColumns(db, "workspaces", [
      "ownership TEXT NOT NULL DEFAULT 'external'",
      "owner_session_id TEXT",
    ]);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_owner_session
      ON workspaces (owner_session_id)
      WHERE owner_session_id IS NOT NULL;

      CREATE TRIGGER IF NOT EXISTS workspaces_ownership_insert_guard
      BEFORE INSERT ON workspaces
      WHEN NEW.ownership NOT IN ('external', 'managed')
        OR (NEW.ownership = 'managed' AND NEW.owner_session_id IS NULL)
        OR (NEW.ownership = 'external' AND NEW.owner_session_id IS NOT NULL)
      BEGIN
        SELECT RAISE(ABORT, 'invalid_workspace_ownership');
      END;

      CREATE TRIGGER IF NOT EXISTS workspaces_ownership_update_guard
      BEFORE UPDATE OF ownership, owner_session_id ON workspaces
      WHEN NEW.ownership NOT IN ('external', 'managed')
        OR (NEW.ownership = 'managed' AND NEW.owner_session_id IS NULL)
        OR (NEW.ownership = 'external' AND NEW.owner_session_id IS NOT NULL)
      BEGIN
        SELECT RAISE(ABORT, 'invalid_workspace_ownership');
      END;
    `);
  },
};
