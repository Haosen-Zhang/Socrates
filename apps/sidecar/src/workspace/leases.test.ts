import { describe, expect, it } from "bun:test";
import { openDb } from "../db";
import { WorkspaceLeaseManager } from "./leases";

function setup() {
  const db = openDb(":memory:");
  db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("w", "/tmp/w", "/tmp/w", "hash", "w", "now", "now");
  return new WorkspaceLeaseManager(db, "instance-1");
}

describe("WorkspaceLeaseManager", () => {
  it("allows only one active write lease", () => {
    const manager = setup();
    manager.acquire("w", "task-1", "write", "2099-01-01T00:00:00.000Z");
    expect(() => manager.acquire("w", "task-2", "write", "2099-01-01T00:00:00.000Z")).toThrow("workspace_write_lease_busy");
  });

  it("reclaims only expired leases and release checks ownership", () => {
    const manager = setup();
    const lease = manager.acquire("w", "task-1", "write", "2020-01-01T00:00:00.000Z");
    expect(manager.acquire("w", "task-2", "write", "2099-01-01T00:00:00.000Z", "2021-01-01T00:00:00.000Z").taskId).toBe("task-2");
    expect(manager.release(lease.id)).toBe(false);
  });
});
