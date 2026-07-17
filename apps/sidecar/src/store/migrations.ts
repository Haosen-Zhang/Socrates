import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export interface Migration {
  version: number;
  name: string;
  checksum: string;
  up(db: Database): void;
}

type AppliedMigration = { version: number; name: string; checksum: string };

export function migrationChecksum(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export function hasPendingMigrations(db: Database, migrations: readonly Migration[]): boolean {
  const table = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!table) return migrations.length > 0;
  const applied = new Set(db.query<{ version: number }, []>("SELECT version FROM schema_migrations").all().map((row) => row.version));
  return migrations.some((migration) => !applied.has(migration.version));
}

/** VACUUM INTO reads a consistent snapshot, including committed WAL pages. */
export function createConsistentBackup(db: Database, targetPath: string): void {
  db.query("VACUUM INTO ?").run(targetPath);
}

export function runMigrations(db: Database, migrations: readonly Migration[]): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const versions = new Set<number>();
  for (const migration of ordered) {
    if (!Number.isInteger(migration.version) || migration.version <= 0 || versions.has(migration.version)) {
      throw new Error(`invalid_migration_version:${migration.version}`);
    }
    if (!/^[a-f0-9]{64}$/u.test(migration.checksum)) throw new Error(`invalid_migration_checksum:${migration.version}`);
    versions.add(migration.version);
  }

  const applied = db.query<AppliedMigration, []>("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all();
  for (const record of applied) {
    const migration = ordered.find((candidate) => candidate.version === record.version);
    if (!migration) throw new Error(`unknown_applied_migration:${record.version}`);
    if (migration.checksum !== record.checksum) throw new Error(`migration_checksum_mismatch:${record.version}`);
  }

  const appliedVersions = new Set(applied.map((record) => record.version));
  const completed: number[] = [];
  for (const migration of ordered) {
    if (appliedVersions.has(migration.version)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      db.query("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)")
        .run(migration.version, migration.name, migration.checksum, new Date().toISOString());
      db.exec("COMMIT");
      completed.push(migration.version);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return completed;
}

export function ensureColumns(db: Database, table: string, definitions: readonly string[]): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error("invalid_table_name");
  const existing = new Set(
    db.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`).all().map((column) => column.name),
  );
  for (const definition of definitions) {
    const column = definition.split(/\s+/u)[0];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) throw new Error("invalid_column_name");
    if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}
