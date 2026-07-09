import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  // ponytail: CREATE IF NOT EXISTS 即全部迁移策略，schema 开始演进时换正式 migration
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      base_url TEXT NOT NULL,
      default_model TEXT,
      api_key_ref TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      temperature REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS room_agents (
      room_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (room_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      role TEXT NOT NULL,
      agent_id TEXT,
      agent_name TEXT,
      model TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_room ON messages (room_id, created_at)
  `);
  return db;
}

/** MVP 仅 macOS（NFR-005），数据目录跟随 Tauri identifier */
export function defaultDbPath(): string {
  const dir =
    process.env.SOCRATES_DATA_DIR ??
    `${homedir()}/Library/Application Support/dev.haosen.socrates`;
  mkdirSync(dir, { recursive: true });
  return `${dir}/socrates.db`;
}
