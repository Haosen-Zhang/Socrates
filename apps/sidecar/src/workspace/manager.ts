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
      this.db.query("UPDATE workspaces SET display_path = ?, last_opened_at = ? WHERE id = ?").run(displayPath, now, existing.id);
      return toRecord(this.db.query<WorkspaceRow, [string]>("SELECT * FROM workspaces WHERE id = ?").get(existing.id)!);
    }
    const id = crypto.randomUUID();
    this.db.query(`
      INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, canonicalPath, displayPath, identityHash, basename(canonicalPath) || canonicalPath, now, now);
    return toRecord(this.db.query<WorkspaceRow, [string]>("SELECT * FROM workspaces WHERE id = ?").get(id)!);
  }

  get(id: string): WorkspaceRecord | null {
    const row = this.db.query<WorkspaceRow, [string]>("SELECT * FROM workspaces WHERE id = ?").get(id);
    return row ? toRecord(row) : null;
  }

  listRecent(limit = 12): WorkspaceRecord[] {
    return this.db.query<WorkspaceRow, [number]>("SELECT * FROM workspaces ORDER BY last_opened_at DESC LIMIT ?")
      .all(Math.max(1, Math.min(limit, 50))).map(toRecord);
  }
}
