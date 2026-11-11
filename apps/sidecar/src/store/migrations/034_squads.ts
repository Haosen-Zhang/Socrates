import { migrationChecksum, type Migration } from '../migrations';
export const squadsMigration: Migration = {
  version: 34, name: 'squads', checksum: migrationChecksum('034:project-squads-frozen-room-bindings:v1'),
  up(db) { db.exec(`
    CREATE TABLE squad_templates (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      name TEXT NOT NULL CHECK(length(trim(name)) > 0),
      avatar TEXT,
      leader_agent_id TEXT NOT NULL REFERENCES agents(id),
      description TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, name)
    );
    CREATE TABLE squad_members (
      squad_id TEXT NOT NULL REFERENCES squad_templates(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      responsibility TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(squad_id, agent_id)
    );
    CREATE TABLE squad_binding_versions(room_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, version INTEGER NOT NULL);
    CREATE TABLE squad_room_bindings (
      room_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      squad_id TEXT NOT NULL REFERENCES squad_templates(id),
      revision INTEGER NOT NULL,
      binding_version INTEGER NOT NULL DEFAULT 1,
      snapshot_json TEXT NOT NULL
    );
    CREATE INDEX squad_room_bindings_template ON squad_room_bindings(squad_id);
  `); },
};
