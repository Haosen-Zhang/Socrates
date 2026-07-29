import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createConsistentBackup, runMigrations, type Migration } from "./migrations";
import { migrations } from "./migrations/index";

describe("migration runner", () => {
  it("upgrades an old schema without losing data and is idempotent", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO rooms VALUES ('room-1', 'Legacy', 'now', 'now');
    `);
    expect(runMigrations(db, migrations)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(db.query("SELECT name FROM rooms WHERE id = 'room-1'").get()).toEqual({ name: "Legacy" });
    expect(db.query("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 10 });
    expect(runMigrations(db, migrations)).toEqual([]);
  });

  it("refuses checksum drift", () => {
    const db = new Database(":memory:");
    runMigrations(db, migrations);
    const drifted = migrations.map((migration) => migration.version === 1 ? { ...migration, checksum: "f".repeat(64) } : migration);
    expect(() => runMigrations(db, drifted)).toThrow("migration_checksum_mismatch:1");
  });

  it("rolls back the entire failed migration", () => {
    const db = new Database(":memory:");
    const broken: Migration = {
      version: 1,
      name: "broken",
      checksum: "0".repeat(64),
      up(database) {
        database.exec("CREATE TABLE should_not_exist (id TEXT)");
        throw new Error("injected_failure");
      },
    };
    expect(() => runMigrations(db, [broken])).toThrow("injected_failure");
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'should_not_exist'").get()).toBeNull();
    expect(db.query("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 0 });
  });

  it("creates a readable consistent SQLite backup", () => {
    const target = `${tmpdir()}/socrates-migration-backup-${crypto.randomUUID()}.db`;
    const db = new Database(":memory:");
    db.exec("CREATE TABLE proof (value TEXT); INSERT INTO proof VALUES ('kept')");
    try {
      createConsistentBackup(db, target);
      expect(existsSync(target)).toBe(true);
      const backup = new Database(target, { readonly: true });
      expect(backup.query("SELECT value FROM proof").get()).toEqual({ value: "kept" });
      backup.close();
    } finally {
      rmSync(target, { force: true });
    }
  });
});
