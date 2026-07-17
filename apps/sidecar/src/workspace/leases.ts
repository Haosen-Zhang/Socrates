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
  constructor(private readonly db: Database, private readonly ownerInstanceId: string) {}

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
