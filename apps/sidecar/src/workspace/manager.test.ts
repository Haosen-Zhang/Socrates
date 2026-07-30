import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "../db";
import { WorkspaceManager } from "./manager";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("WorkspaceManager managed roots", () => {
  it("canonicalizes aliases into one durable external identity", () => {
    const root = `${tmpdir()}/socrates-workspace-manager-${crypto.randomUUID()}`;
    roots.push(root);
    mkdirSync(root, { recursive: true });
    const manager = new WorkspaceManager(openDb(":memory:"));
    const first = manager.select(root);
    const second = manager.select(`${root}/.`);
    expect(second.id).toBe(first.id);
    expect(manager.listRecent()).toHaveLength(1);
  });

  it("rejects missing paths and files", () => {
    const root = `${tmpdir()}/socrates-workspace-file-${crypto.randomUUID()}`;
    roots.push(root);
    writeFileSync(root, "file");
    const manager = new WorkspaceManager(openDb(":memory:"));
    expect(() => manager.select(`${root}-missing`)).toThrow("workspace_not_found");
    expect(() => manager.select(root)).toThrow("workspace_not_directory");
  });

  it("creates a stable room-owned directory without exposing the parent Documents folder", () => {
    const managedRoot = `${tmpdir()}/socrates-managed-${crypto.randomUUID()}`;
    roots.push(managedRoot);
    const manager = new WorkspaceManager(openDb(":memory:"), managedRoot);

    const workspace = manager.createManaged("room-123", "Research");

    expect(workspace.canonicalPath).toBe(realpathSync(`${managedRoot}/room-123`));
    expect(workspace.displayPath).toBe(workspace.canonicalPath);
    expect(workspace.ownership).toBe("managed");
    expect(workspace.ownerSessionId).toBe("room-123");
    expect(existsSync(workspace.canonicalPath)).toBe(true);
    expect(manager.createManaged("room-123", "Changed title").id).toBe(workspace.id);
  });

  it("keeps a selected existing directory external", () => {
    const managedRoot = `${tmpdir()}/socrates-managed-${crypto.randomUUID()}`;
    const existing = `${tmpdir()}/socrates-existing-${crypto.randomUUID()}`;
    roots.push(managedRoot, existing);
    mkdirSync(existing, { recursive: true });
    const manager = new WorkspaceManager(openDb(":memory:"), managedRoot);

    expect(manager.select(existing)).toMatchObject({
      ownership: "external",
      ownerSessionId: null,
    });
  });

  it("removes a newly created empty directory when managed metadata insertion fails", () => {
    const managedRoot = `${tmpdir()}/socrates-managed-${crypto.randomUUID()}`;
    roots.push(managedRoot);
    const db = openDb(":memory:");
    db.exec(`
      CREATE TRIGGER reject_test_managed_workspace
      BEFORE INSERT ON workspaces
      WHEN NEW.ownership = 'managed'
      BEGIN
        SELECT RAISE(ABORT, 'injected_failure');
      END;
    `);
    const manager = new WorkspaceManager(db, managedRoot);
    expect(() => manager.createManaged("room-failed", "Failure")).toThrow("injected_failure");
    expect(existsSync(`${managedRoot}/room-failed`)).toBe(false);
  });

  it("refuses owner or canonical-path mismatches before staging deletion", () => {
    const managedRoot = `${tmpdir()}/socrates-managed-${crypto.randomUUID()}`;
    const outside = `${tmpdir()}/socrates-outside-${crypto.randomUUID()}`;
    roots.push(managedRoot, outside);
    mkdirSync(outside, { recursive: true });
    writeFileSync(`${outside}/proof.txt`, "keep");
    const db = openDb(":memory:");
    const manager = new WorkspaceManager(db, managedRoot);
    const workspace = manager.createManaged("room-safe", "Safe");

    expect(() => manager.stageManagedDeletion(workspace.id, "other-room"))
      .toThrow("managed_workspace_owner_mismatch");
    db.query("UPDATE workspaces SET canonical_path = ? WHERE id = ?").run(realpathSync(outside), workspace.id);
    expect(() => manager.stageManagedDeletion(workspace.id, "room-safe"))
      .toThrow("managed_workspace_path_mismatch");
    expect(existsSync(`${outside}/proof.txt`)).toBe(true);
  });

  it("restores the original managed path when a staged database operation fails", () => {
    const managedRoot = `${tmpdir()}/socrates-managed-${crypto.randomUUID()}`;
    roots.push(managedRoot);
    const manager = new WorkspaceManager(openDb(":memory:"), managedRoot);
    const workspace = manager.createManaged("room-rollback", "Rollback");
    const staged = manager.stageManagedDeletion(workspace.id, "room-rollback");

    expect(existsSync(workspace.canonicalPath)).toBe(false);
    staged.rollback();

    expect(existsSync(workspace.canonicalPath)).toBe(true);
    expect(manager.get(workspace.id)).not.toBeNull();
  });
});
