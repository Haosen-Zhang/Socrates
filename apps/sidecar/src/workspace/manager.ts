import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { WorkspaceRecord } from "@socrates/core";

type WorkspaceRow = {
  id: string;
  canonical_path: string;
  display_path: string;
  identity_hash: string;
  label: string;
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
    archived: row.archived === 1,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
  };
}

export class WorkspaceManager {
  constructor(private readonly db: Database) {}

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
      INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, archived, created_at, last_opened_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, canonicalPath, displayPath, identityHash, basename(canonicalPath) || canonicalPath, now, now);
    return toRecord(this.db.query<WorkspaceRow, [string]>("SELECT * FROM workspaces WHERE id = ?").get(id)!);
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
