import type { Migration } from "../migrations";
import { ensureColumns, migrationChecksum } from "../migrations";

/** Project metadata is app-local: removing a project never touches its directory on disk. */
export const projectConversationOrganizationMigration: Migration = {
  version: 8,
  name: "project_conversation_organization",
  checksum: migrationChecksum("008:project-conversation-organization:v1:workspace-archive-room-workspace-session-archive"),
  up(db) {
    ensureColumns(db, "workspaces", ["archived INTEGER NOT NULL DEFAULT 0"]);
    ensureColumns(db, "rooms", ["workspace_id TEXT"]);
    ensureColumns(db, "sessions", ["archived INTEGER NOT NULL DEFAULT 0"]);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_rooms_workspace ON rooms (workspace_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_workspace_archived ON sessions (workspace_id, archived, updated_at);
      CREATE INDEX IF NOT EXISTS idx_workspaces_archived_recent ON workspaces (archived, last_opened_at);
    `);
  },
};
