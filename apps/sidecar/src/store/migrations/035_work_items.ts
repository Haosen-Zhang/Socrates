import { migrationChecksum, type Migration } from '../migrations';
export const workItemsMigration: Migration = {
  version: 35, name: 'work_items', checksum: migrationChecksum('035:work-items:v2'),
  up(db) { db.exec(`
    CREATE TABLE work_items (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), room_id TEXT REFERENCES sessions(id) ON DELETE SET NULL, source_message_id TEXT REFERENCES session_messages(id) ON DELETE SET NULL, title TEXT NOT NULL, objective TEXT NOT NULL, acceptance_json TEXT NOT NULL, owner_kind TEXT NOT NULL CHECK(owner_kind IN ('user','agent','squad')), owner_id TEXT, priority TEXT NOT NULL CHECK(priority IN ('low','normal','high')), manual_state TEXT NOT NULL CHECK(manual_state IN ('backlog','todo')), review_state TEXT NOT NULL CHECK(review_state IN ('pending','accepted','changes_requested')), revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE work_item_runs (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL REFERENCES work_items(id), client_request_id TEXT NOT NULL, command_id TEXT REFERENCES room_commands(id), execution_room_id TEXT REFERENCES sessions(id), frozen_owner_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('preparing','dispatched')), request_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(work_item_id, client_request_id));
    CREATE TABLE work_item_reviews (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL REFERENCES work_items(id), decision TEXT NOT NULL CHECK(decision IN ('accept','request_changes')), revision INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX work_items_workspace ON work_items(workspace_id, updated_at);
  `); }
};
