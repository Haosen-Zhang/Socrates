import type { Migration } from "../migrations";
import { migrationChecksum } from "../migrations";

export const historyProjectionMigration: Migration = {
  version: 16,
  name: "history_projection",
  checksum: migrationChecksum("016:history-projection:v1:state-record-offset-epoch-recovery"),
  up(db) {
    db.exec(`
      CREATE TABLE history_projection_state (
        session_id TEXT PRIMARY KEY,
        projected_offset INTEGER NOT NULL DEFAULT 0,
        projected_sequence INTEGER NOT NULL DEFAULT 0,
        current_epoch INTEGER NOT NULL DEFAULT 0,
        last_hash TEXT,
        status TEXT NOT NULL DEFAULT 'ready',
        error TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE history_projection_records (
        record_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        epoch INTEGER NOT NULL,
        byte_offset INTEGER NOT NULL,
        byte_length INTEGER NOT NULL,
        record_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, record_id),
        UNIQUE (session_id, sequence),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_history_projection_records_thread
        ON history_projection_records (thread_id, sequence);
    `);
  },
};
