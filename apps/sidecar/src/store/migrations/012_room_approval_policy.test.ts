import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../migrations";
import { migrations } from "./index";

describe("012 room approval policy migration", () => {
  it("backfills the conservative policy without changing existing sessions", () => {
    const db = new Database(":memory:");
    runMigrations(db, migrations.filter((migration) => migration.version <= 11));
    db.exec(`
      INSERT INTO sessions
        (id, title, mode, kind, workspace_id, archived, status, created_at, updated_at)
      VALUES ('existing', 'Existing', 'chat', 'chat', NULL, 0, 'idle', 'now', 'now')
    `);

    runMigrations(db, migrations);

    expect(db.query("SELECT id, approval_policy, approval_policy_version FROM sessions WHERE id = 'existing'").get())
      .toEqual({ id: "existing", approval_policy: "ask", approval_policy_version: 1 });
    expect(() => db.query("UPDATE sessions SET approval_policy = 'unrestricted' WHERE id = 'existing'").run())
      .toThrow("invalid_approval_policy");
  });
});
