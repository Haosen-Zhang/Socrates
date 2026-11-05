import type { Database } from "bun:sqlite";

export interface WorkspaceLease {
  id: string;
  workspaceId: string;
  taskId: string;
  mode: "read" | "write";
  ownerInstanceId: string;
  expiresAt: string;
}

type LeaseRow = { id: string; workspace_id: string; task_id: string; mode: "read" | "write"; owner_instance_id: string; expires_at: string };
const toLease = (row: LeaseRow): WorkspaceLease => ({ id: row.id, workspaceId: row.workspace_id, taskId: row.task_id, mode: row.mode, ownerInstanceId: row.owner_instance_id, expiresAt: row.expires_at });

export class WorkspaceLeaseManager {
  private readonly writers = new Map<string, object[]>();
  constructor(private readonly db: Database, private readonly ownerInstanceId: string) {}

  /** One FIFO for all native writers; the child run, never its coordinator, owns the lease. */
  async acquireQueued(workspaceId: string, taskId: string, input: {
    signal?: AbortSignal;
    onWaiting?: () => void | Promise<void>;
  } = {}): Promise<WorkspaceLease> {
    this.reclaimStoppedOwners();
    const ticket = {};
    const queue = this.writers.get(workspaceId) ?? [];
    queue.push(ticket);
    this.writers.set(workspaceId, queue);
    let notified = false;
    try {
      while (true) {
        input.signal?.throwIfAborted();
        if (queue[0] === ticket) {
          try {
            return this.acquire(workspaceId, taskId, "write", new Date(Date.now() + 30 * 60_000).toISOString());
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "workspace_write_lease_busy") throw error;
          }
        }
        if (!notified) { notified = true; await input.onWaiting?.(); }
        await new Promise<void>((resolve, reject) => {
          const finish = () => { input.signal?.removeEventListener("abort", aborted); resolve(); };
          const timer = setTimeout(finish, 25);
          const aborted = () => { clearTimeout(timer); input.signal?.removeEventListener("abort", aborted); reject(input.signal?.reason ?? new Error("cancelled")); };
          input.signal?.addEventListener("abort", aborted, { once: true });
          if (input.signal?.aborted) aborted();
        });
      }
    } finally {
      queue.splice(queue.indexOf(ticket), 1);
      if (!queue.length) this.writers.delete(workspaceId);
    }
  }

  /** Restart recovery first marks orphan runs interrupted; their old lease must not stall work for its full TTL. */
  reclaimStoppedOwners(): number {
    const packagesExist = this.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_package_attempts'").get();
    return this.db.query(`DELETE FROM workspace_leases WHERE owner_instance_id != ? AND (
      task_id IN (SELECT id FROM agent_runs WHERE status IN ('completed', 'failed', 'cancelled', 'interrupted'))
      OR task_id IN (SELECT id FROM multi_tasks WHERE state IN ('completed', 'failed', 'cancelled', 'paused'))
      ${packagesExist ? "OR task_id IN (SELECT run_id FROM work_package_attempts WHERE status != 'running')" : ""}
    )`).run(this.ownerInstanceId).changes;
  }

  acquire(workspaceId: string, taskId: string, mode: "read" | "write", expiresAt: string, now = new Date().toISOString()): WorkspaceLease {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.query("DELETE FROM workspace_leases WHERE expires_at <= ?").run(now);
      if (mode === "write") {
        const busy = this.db.query<LeaseRow, [string]>("SELECT * FROM workspace_leases WHERE workspace_id = ? AND mode = 'write'").get(workspaceId);
        if (busy) throw new Error("workspace_write_lease_busy");
      }
      const id = crypto.randomUUID();
      this.db.query("INSERT INTO workspace_leases (id, workspace_id, task_id, mode, owner_instance_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, workspaceId, taskId, mode, this.ownerInstanceId, expiresAt);
      this.db.exec("COMMIT");
      return { id, workspaceId, taskId, mode, ownerInstanceId: this.ownerInstanceId, expiresAt };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  release(id: string): boolean {
    return this.db.query("DELETE FROM workspace_leases WHERE id = ? AND owner_instance_id = ?").run(id, this.ownerInstanceId).changes === 1;
  }

  renew(id: string, expiresAt: string): WorkspaceLease {
    const changed = this.db.query("UPDATE workspace_leases SET expires_at = ? WHERE id = ? AND owner_instance_id = ?")
      .run(expiresAt, id, this.ownerInstanceId).changes;
    if (changed !== 1) throw new Error("workspace_lease_lost");
    return this.get(id)!;
  }

  get(id: string): WorkspaceLease | null {
    const row = this.db.query<LeaseRow, [string]>("SELECT * FROM workspace_leases WHERE id = ?").get(id);
    return row ? toLease(row) : null;
  }
}
