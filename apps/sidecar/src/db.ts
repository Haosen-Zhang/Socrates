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
    )
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
