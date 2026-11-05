import { migrationChecksum, type Migration } from "../migrations";

export const roomCommandsMigration: Migration = {
  version: 20, name: "structured_room_commands",
  checksum: migrationChecksum("020:room-commands:request-identity-mentions-events:chat-workspace-boundary:v2"),
  up(db) {
    db.exec("UPDATE rooms SET workspace_id = NULL WHERE workspace_id IS NOT NULL; UPDATE sessions SET workspace_id = NULL WHERE kind = 'chat' AND workspace_id IS NOT NULL;");
    db.exec(`CREATE TABLE room_commands (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      client_request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, input_json TEXT NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL, run_id TEXT, task_id TEXT, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(room_id, client_request_id)
    );
    CREATE TABLE room_command_events (
      command_id TEXT NOT NULL REFERENCES room_commands(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL,
      PRIMARY KEY(command_id, seq)
    );`);
  },
};
