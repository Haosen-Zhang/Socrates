import type { Migration } from "../migrations";
import { migrationChecksum } from "../migrations";

export const usageAndRecoveryMigration: Migration = {
  version: 7,
  name: "usage_effort_and_context_compaction",
  checksum: migrationChecksum("007:usage:v1:records-agent-capabilities-compactions"),
  up(db) {
    db.exec(`
      ALTER TABLE agents ADD COLUMN reasoning_effort TEXT;
      ALTER TABLE agents ADD COLUMN model_capabilities_json TEXT;
      CREATE TABLE usage_records (
        id TEXT PRIMARY KEY, stable_key TEXT NOT NULL UNIQUE,
        session_id TEXT, room_id TEXT, task_id TEXT, turn_id TEXT, agent_id TEXT,
        input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
        cached_input_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
        cost REAL, currency TEXT, source TEXT NOT NULL, estimated INTEGER NOT NULL,
        effort TEXT, created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
      CREATE INDEX idx_usage_task_agent ON usage_records (task_id, agent_id, created_at);
      CREATE INDEX idx_usage_room_agent ON usage_records (room_id, agent_id, created_at);
      CREATE TABLE multi_compactions (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, covered_from INTEGER NOT NULL,
        covered_to INTEGER NOT NULL, source_hash TEXT NOT NULL, summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES multi_tasks(id) ON DELETE CASCADE
      );
    `);
  },
};
