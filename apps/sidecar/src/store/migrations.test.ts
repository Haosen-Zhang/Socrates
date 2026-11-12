import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createConsistentBackup, runMigrations, type Migration } from "./migrations";
import { SessionStore } from "./session-store";
import { migrations } from "./migrations/index";

describe("migration runner", () => {
  it("upgrades an old schema without losing data and is idempotent", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO rooms VALUES ('room-1', 'Legacy', 'now', 'now');
    `);
    expect(runMigrations(db, migrations)).toEqual(migrations.map((migration) => migration.version));
    expect(db.query("SELECT name FROM rooms WHERE id = 'room-1'").get()).toEqual({ name: "Legacy" });
    expect(db.query("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: migrations.length });
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


it("P05-P07 upgrades a persisted P04 database without changing existing rows", () => {
  const path = `${tmpdir()}/socrates-p05-upgrade-${crypto.randomUUID()}.db`;
  let db = new Database(path);
  try {
    runMigrations(db, migrations.filter(m => m.version <= 28));
    const room = new SessionStore(db).create({title:"Preserved Chat",mode:"chat",primaryAgentId:"fixture",agents:[{agentId:"fixture",snapshot:{nickname:"Fixture"},executionEligible:false}]});
    db.query("INSERT INTO session_messages(id,session_id,role,content,status,created_at) VALUES (?,?, 'user','Preserved history','completed','now')").run("kept-message",room.id);
    const tables = db.query<{name:string},[]>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_migrations' ORDER BY name").all().map(r=>r.name);
    const snapshot = () => Object.fromEntries(tables.map(name=>[name,db.query(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
    const before = snapshot();
    expect(runMigrations(db,migrations)).toEqual([29,30,31,32,33,34,35,36,37,38,39,40]);
    expect(snapshot()).toEqual(before);
    db.close(); db = new Database(path);
    expect(runMigrations(db,migrations)).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect(new SessionStore(db).get(room.id)?.title).toBe("Preserved Chat");
    expect(db.query("PRAGMA integrity_check").get()).toEqual({integrity_check:"ok"});
  } finally { db.close(); rmSync(path,{force:true}); }
});
