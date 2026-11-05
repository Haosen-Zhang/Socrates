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
  it("reclaims a stopped run's old-instance lease while preserving a live writer", () => {
    const db = openDb(":memory:");
    db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("w", "/tmp/w", "/tmp/w", "hash", "w", "now", "now");
    db.query("INSERT INTO sessions (id, title, mode, workspace_id, status, created_at, updated_at) VALUES ('s', 's', 'multi_agent', 'w', 'idle', 'now', 'now')").run();
    db.query("INSERT INTO multi_tasks (id, session_id, prompt, state, config_json, created_at, updated_at) VALUES ('stopped', 's', 's', 'paused', '{}', 'now', 'now')").run();
    const old = new WorkspaceLeaseManager(db, "old");
    old.acquire("w", "stopped", "write", "2099-01-01T00:00:00.000Z");
    const current = new WorkspaceLeaseManager(db, "current");
    expect(current.reclaimStoppedOwners()).toBe(1);
    const live = old.acquire("w", "live", "write", "2099-01-01T00:00:00.000Z");
    expect(current.reclaimStoppedOwners()).toBe(0);
    expect(current.get(live.id)?.taskId).toBe("live");
  });

  it("queues writers and cancels a waiting writer without taking the lease", async () => {
    const manager = setup();
    const first = manager.acquire("w", "first", "write", "2099-01-01T00:00:00.000Z");
    const abort = new AbortController();
    let waiting = false;
    const cancelled = manager.acquireQueued("w", "cancelled", { signal: abort.signal, onWaiting: () => { waiting = true; } });
    await Promise.resolve();
    expect(waiting).toBe(true);
    const rejected = cancelled.catch((error: Error) => error);
    abort.abort(new Error("cancelled"));
    expect((await rejected as Error).message).toBe("cancelled");
    const next = manager.acquireQueued("w", "next");
    manager.release(first.id);
    const lease = await next;
    expect(lease.taskId).toBe("next");
    manager.release(lease.id);
  });

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
