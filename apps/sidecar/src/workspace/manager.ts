import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { WorkspaceRecord } from "@socrates/core";

type WorkspaceRow = {
  id: string;
  canonical_path: string;
  display_path: string;
  identity_hash: string;
  label: string;
  ownership: "external" | "managed";
  owner_session_id: string | null;
  archived: number;
  created_at: string;
  last_opened_at: string;
};

function toRecord(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    canonicalPath: row.canonical_path,
    displayPath: row.display_path,
    identityHash: row.identity_hash,
    label: row.label,
    ownership: row.ownership,
    ownerSessionId: row.owner_session_id,
    archived: row.archived === 1,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
  };
}

export class WorkspaceManager {
  constructor(
    private readonly db: Database,
    private readonly managedRoot = join(homedir(), "Documents", "Socrates", "Workspaces"),
  ) {}

  select(displayPath: string): WorkspaceRecord {
    let canonicalPath: string;
    try {
      canonicalPath = realpathSync(displayPath).normalize("NFC");
    } catch {
      throw new Error("workspace_not_found");
    }
    if (!statSync(canonicalPath).isDirectory()) throw new Error("workspace_not_directory");
    const identityHash = createHash("sha256").update(canonicalPath).digest("hex");
    const existing = this.db.query<WorkspaceRow, [string]>("SELECT * FROM workspaces WHERE identity_hash = ?").get(identityHash);
    const now = new Date().toISOString();
    if (existing) {
      this.db.query("UPDATE workspaces SET display_path = ?, last_opened_at = ?, archived = 0 WHERE id = ?").run(displayPath, now, existing.id);
      return toRecord(this.db.query<WorkspaceRow, [string]>("SELECT * FROM workspaces WHERE id = ?").get(existing.id)!);
    }
    const id = crypto.randomUUID();
    this.db.query(`
      INSERT INTO workspaces
        (id, canonical_path, display_path, identity_hash, label, ownership,
         owner_session_id, archived, created_at, last_opened_at)
      VALUES (?, ?, ?, ?, ?, 'external', NULL, 0, ?, ?)
    `).run(id, canonicalPath, displayPath, identityHash, basename(canonicalPath) || canonicalPath, now, now);
    return toRecord(this.db.query<WorkspaceRow, [string]>("SELECT * FROM workspaces WHERE id = ?").get(id)!);
  }

  createManaged(ownerSessionId: string, label: string): WorkspaceRecord {
    if (!/^[A-Za-z0-9_-]+$/u.test(ownerSessionId)) throw new Error("managed_workspace_owner_invalid");
    const existing = this.db.query<WorkspaceRow, [string]>(
      "SELECT * FROM workspaces WHERE owner_session_id = ?",
    ).get(ownerSessionId);
    if (existing) return toRecord(existing);

    mkdirSync(this.managedRoot, { recursive: true });
    const displayPath = join(this.managedRoot, ownerSessionId);
    mkdirSync(displayPath, { recursive: false });
    const canonicalPath = realpathSync(displayPath).normalize("NFC");
    const identityHash = createHash("sha256").update(canonicalPath).digest("hex");
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    try {
      this.db.query(`
        INSERT INTO workspaces
          (id, canonical_path, display_path, identity_hash, label, ownership,
           owner_session_id, archived, created_at, last_opened_at)
        VALUES (?, ?, ?, ?, ?, 'managed', ?, 0, ?, ?)
      `).run(
        id,
        canonicalPath,
        canonicalPath,
        identityHash,
        label.trim() || "Untitled",
        ownerSessionId,
        now,
        now,
      );
    } catch (error) {
      try {
        rmdirSync(canonicalPath);
      } catch {
        // Never recursively clean up a path whose contents changed unexpectedly.
      }
      throw error;
    }
    return this.get(id)!;
  }

  discardManaged(ownerSessionId: string): void {
    const workspace = this.db.query<WorkspaceRow, [string]>(
      "SELECT * FROM workspaces WHERE owner_session_id = ? AND ownership = 'managed'",
    ).get(ownerSessionId);
    if (!workspace) return;
    this.db.query("DELETE FROM workspaces WHERE id = ?").run(workspace.id);
    try {
      rmdirSync(workspace.canonical_path);
    } catch {
      // A failed creation cleanup must never recursively delete unexpected data.
    }
  }

  releaseManaged(workspaceId: string, ownerSessionId: string): WorkspaceRecord {
    const workspace = this.db.query<WorkspaceRow, [string, string]>(
      "SELECT * FROM workspaces WHERE id = ? AND ownership = 'managed' AND owner_session_id = ?",
    ).get(workspaceId, ownerSessionId);
    if (!workspace) throw new Error("managed_workspace_owner_mismatch");
    this.db.query(
      "UPDATE workspaces SET ownership = 'external', owner_session_id = NULL WHERE id = ?",
    ).run(workspaceId);
    return this.get(workspaceId)!;
  }

  stageManagedDeletion(workspaceId: string, ownerSessionId: string): {
    forgetRecord: () => void;
    rollback: () => void;
    finalize: () => boolean;
  } {
    const workspace = this.db.query<WorkspaceRow, [string, string]>(
      "SELECT * FROM workspaces WHERE id = ? AND ownership = 'managed' AND owner_session_id = ?",
    ).get(workspaceId, ownerSessionId);
    if (!workspace) throw new Error("managed_workspace_owner_mismatch");
    const root = realpathSync(this.managedRoot).normalize("NFC");
    const expected = join(root, ownerSessionId).normalize("NFC");
    if (workspace.canonical_path !== expected) throw new Error("managed_workspace_path_mismatch");
    const staged = join(root, `.delete-${ownerSessionId}-${crypto.randomUUID()}`);
    renameSync(workspace.canonical_path, staged);
    return {
      forgetRecord: () => {
        const changes = this.db.query(
          "DELETE FROM workspaces WHERE id = ? AND ownership = 'managed' AND owner_session_id = ?",
        ).run(workspaceId, ownerSessionId).changes;
        if (changes !== 1) throw new Error("managed_workspace_owner_mismatch");
      },
      rollback: () => {
        if (existsSync(staged) && !existsSync(workspace.canonical_path)) {
          renameSync(staged, workspace.canonical_path);
        }
      },
      finalize: () => {
        try {
          rmSync(staged, { recursive: true, force: true });
          return true;
        } catch {
          // The room deletion is already committed. Keep the isolated tombstone
          // recoverable instead of reporting a false whole-operation failure.
          return false;
        }
      },
    };
  }

  get(id: string): WorkspaceRecord | null {
    const row = this.db.query<WorkspaceRow, [string]>("SELECT * FROM workspaces WHERE id = ?").get(id);
    return row ? toRecord(row) : null;
  }

  listRecent(limit = 12): WorkspaceRecord[] {
    return this.db.query<WorkspaceRow, [number]>("SELECT * FROM workspaces ORDER BY archived, last_opened_at DESC LIMIT ?")
      .all(Math.max(1, Math.min(limit, 50))).map(toRecord);
  }

  rename(id: string, label: string): WorkspaceRecord {
    const next = label.trim();
    if (!next) throw new Error("workspace_label_required");
    if (next.length > 80) throw new Error("workspace_label_too_long");
    if (!this.get(id)) throw new Error("workspace_not_found");
    this.db.query("UPDATE workspaces SET label = ? WHERE id = ?").run(next, id);
    return this.get(id)!;
  }

  archive(id: string, archived: boolean): WorkspaceRecord {
    if (!this.get(id)) throw new Error("workspace_not_found");
    this.db.query("UPDATE workspaces SET archived = ? WHERE id = ?").run(archived ? 1 : 0, id);
    return this.get(id)!;
  }

  /** Unregister only app metadata; conversation history is retained as ungrouped and no filesystem path is deleted. */
  remove(id: string): void {
    if (!this.get(id)) throw new Error("workspace_not_found");
    const active = this.db.query<{ id: string }, [string]>(`
      SELECT id FROM sessions WHERE workspace_id = ?
      AND status NOT IN ('idle', 'completed', 'failed', 'cancelled', 'interrupted') LIMIT 1
    `).get(id);
    if (active) throw new Error("workspace_has_active_session");
    const mcp = this.db.query<{ id: string }, [string]>("SELECT id FROM mcp_servers WHERE workspace_id = ? LIMIT 1").get(id);
    if (mcp) throw new Error("workspace_has_scoped_mcp");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.query("UPDATE rooms SET workspace_id = NULL WHERE workspace_id = ?").run(id);
      this.db.query("UPDATE sessions SET workspace_id = NULL WHERE workspace_id = ?").run(id);
      this.db.query("DELETE FROM attachment_sources WHERE workspace_id = ?").run(id);
      this.db.query("DELETE FROM workspace_refs WHERE workspace_id = ?").run(id);
      this.db.query("DELETE FROM workspaces WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
