import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createConsistentBackup, hasPendingMigrations, runMigrations } from "./store/migrations";
import { migrations } from "./store/migrations/index";

export function openDb(path: string): Database {
  const existingFile = path !== ":memory:" && existsSync(path) && statSync(path).size > 0;
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  if (existingFile && hasPendingMigrations(db, migrations)) {
    createConsistentBackup(db, `${path}.backup-${new Date().toISOString().replaceAll(":", "-")}`);
  }
  runMigrations(db, migrations);
  return db;
}

/** MVP 仅 macOS（NFR-005），数据目录跟随 Tauri identifier */
export function defaultDbPath(): string {
  const dir = defaultDataDir();
  mkdirSync(dir, { recursive: true });
  return `${dir}/socrates.db`;
}

export function defaultDataDir(): string {
  return process.env.SOCRATES_DATA_DIR ?? `${homedir()}/Library/Application Support/dev.haosen.socrates`;
}
