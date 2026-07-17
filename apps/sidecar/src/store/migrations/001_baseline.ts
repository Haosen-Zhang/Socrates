import type { Migration } from "../migrations";
import { ensureColumns, migrationChecksum } from "../migrations";

export const baselineMigration: Migration = {
  version: 1,
  name: "baseline_existing_product",
  checksum: migrationChecksum("001:baseline_existing_product:v1:providers-agents-rooms-messages-tasks-turns"),
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, base_url TEXT NOT NULL,
        default_model TEXT, api_key_ref TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, display_name TEXT NOT NULL, nickname TEXT, avatar TEXT,
        provider_id TEXT NOT NULL, model_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL DEFAULT '', temperature REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_agents (
        room_id TEXT NOT NULL, agent_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (room_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL, role TEXT NOT NULL, agent_id TEXT,
        agent_name TEXT, agent_avatar TEXT, model TEXT, content TEXT NOT NULL,
        created_at TEXT NOT NULL, task_id TEXT, round INTEGER, phase TEXT, duty TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_room ON messages (room_id, created_at);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL, prompt TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'round_robin', speaking_order TEXT NOT NULL,
        max_rounds INTEGER NOT NULL, final_summarizer_id TEXT NOT NULL, debate_roles TEXT,
        status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, turn_index INTEGER NOT NULL, round INTEGER NOT NULL,
        phase TEXT NOT NULL, duty TEXT, agent_id TEXT NOT NULL, agent_name TEXT NOT NULL,
        model TEXT NOT NULL, status TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
        error TEXT, started_at TEXT NOT NULL, completed_at TEXT
      );
    `);
    ensureColumns(db, "messages", ["task_id TEXT", "round INTEGER", "phase TEXT", "duty TEXT", "agent_avatar TEXT"]);
    ensureColumns(db, "tasks", ["mode TEXT NOT NULL DEFAULT 'round_robin'", "debate_roles TEXT"]);
    ensureColumns(db, "turns", ["duty TEXT"]);
    ensureColumns(db, "rooms", ["archived INTEGER NOT NULL DEFAULT 0"]);
    ensureColumns(db, "agents", ["nickname TEXT", "avatar TEXT"]);
  },
};
