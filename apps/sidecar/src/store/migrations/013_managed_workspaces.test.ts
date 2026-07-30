import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { baselineMigration } from "./001_baseline";
import { agentWorkspaceMigration } from "./002_agent_workspace";
import { managedWorkspacesMigration } from "./013_managed_workspaces";

describe("013 managed workspace migration", () => {
  it("backfills existing projects as external and enforces one managed workspace per room", () => {
    const db = new Database(":memory:");
    baselineMigration.up(db);
    agentWorkspaceMigration.up(db);
    db.query(`
      INSERT INTO workspaces
        (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at)
      VALUES ('existing', '/tmp/project', '/tmp/project', 'hash', 'Project', 'now', 'now')
    `).run();

    managedWorkspacesMigration.up(db);

    expect(db.query("SELECT ownership, owner_session_id FROM workspaces WHERE id = 'existing'").get())
      .toEqual({ ownership: "external", owner_session_id: null });
    db.query(`
      INSERT INTO workspaces
        (id, canonical_path, display_path, identity_hash, label, ownership,
         owner_session_id, created_at, last_opened_at)
      VALUES ('managed', '/tmp/room', '/tmp/room', 'room-hash', 'Room',
        'managed', 'room-1', 'now', 'now')
    `).run();
    expect(() => db.query(`
      INSERT INTO workspaces
        (id, canonical_path, display_path, identity_hash, label, ownership,
         owner_session_id, created_at, last_opened_at)
      VALUES ('duplicate', '/tmp/other', '/tmp/other', 'other-hash', 'Other',
        'managed', 'room-1', 'now', 'now')
    `).run()).toThrow();
    expect(() => db.query(`
      INSERT INTO workspaces
        (id, canonical_path, display_path, identity_hash, label, ownership,
         owner_session_id, created_at, last_opened_at)
      VALUES ('ownerless', '/tmp/ownerless', '/tmp/ownerless', 'ownerless-hash',
        'Ownerless', 'managed', NULL, 'now', 'now')
    `).run()).toThrow("invalid_workspace_ownership");
    expect(() => db.query(`
      UPDATE workspaces SET ownership = 'external'
      WHERE id = 'managed'
    `).run()).toThrow("invalid_workspace_ownership");
  });
});
