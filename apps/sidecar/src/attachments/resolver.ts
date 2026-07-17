import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AttachmentRecord, WorkspaceRecord } from "@socrates/core";
import { WorkspacePathPolicy } from "../workspace/path-policy";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

type AttachmentRow = {
  id: string; sha256: string; media_type: string; filename: string; byte_size: number;
  storage_key: string; status: AttachmentRecord["status"]; created_at: string;
};

const toRecord = (row: AttachmentRow): AttachmentRecord => ({
  id: row.id, sha256: row.sha256, mediaType: row.media_type, filename: row.filename,
  byteSize: row.byte_size, status: row.status, createdAt: row.created_at,
});

function detectMediaType(bytes: Buffer, filename: string): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (!bytes.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return filename.toLowerCase().endsWith(".json") ? "application/json" : "text/plain";
    } catch {
      // Continue to opaque binary.
    }
  }
  return "application/octet-stream";
}

export class AttachmentResolver {
  constructor(private readonly db: Database, private readonly dataRoot: string) {}

  importWorkspaceFile(workspace: WorkspaceRecord, relativePath: string): AttachmentRecord {
    const policy = new WorkspacePathPolicy(workspace.canonicalPath);
    const first = policy.readBytes(relativePath, MAX_FILE_BYTES);
    if (first.truncated) throw new Error("attachment_too_large");
    const record = this.importBytes(workspace.id, basename(relativePath), first.bytes, relativePath);
    return record;
  }

  importClipboardBytes(workspaceId: string, filename: string, bytes: Buffer): AttachmentRecord {
    const safeName = basename(filename.trim() || "clipboard.bin").slice(0, 255);
    return this.importBytes(workspaceId, safeName, bytes, `@clipboard/${crypto.randomUUID()}`);
  }

  private importBytes(workspaceId: string, filename: string, bytes: Buffer, sourceKey: string): AttachmentRecord {
    if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("attachment_too_large");
    const mediaType = detectMediaType(bytes, filename);
    if (mediaType.startsWith("image/") && bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("attachment_image_too_large");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existing = this.db.query<AttachmentRow, [string, number]>("SELECT * FROM attachments WHERE sha256 = ? AND byte_size = ?").get(sha256, bytes.byteLength);
    if (existing) {
      this.linkSource(existing.id, workspaceId, sourceKey);
      return toRecord(existing);
    }

    const storageKey = `attachments/${sha256.slice(0, 2)}/${sha256}`;
    const target = join(this.dataRoot, storageKey);
    mkdirSync(join(this.dataRoot, "attachments", sha256.slice(0, 2)), { recursive: true });
    if (!existsSync(target)) {
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, bytes, { flag: "wx" });
        renameSync(temporary, target);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    }
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db.query(`
      INSERT INTO attachments (id, sha256, media_type, filename, byte_size, storage_key, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'ready', ?)
    `).run(id, sha256, mediaType, filename, bytes.byteLength, storageKey, createdAt);
    this.linkSource(id, workspaceId, sourceKey);
    return { id, sha256, mediaType, filename, byteSize: bytes.byteLength, status: "ready", createdAt };
  }

  get(id: string): AttachmentRecord | null {
    const row = this.db.query<AttachmentRow, [string]>("SELECT * FROM attachments WHERE id = ?").get(id);
    return row ? toRecord(row) : null;
  }

  read(id: string): { record: AttachmentRecord; bytes: Buffer } {
    const row = this.db.query<AttachmentRow, [string]>("SELECT * FROM attachments WHERE id = ?").get(id);
    if (!row || row.status !== "ready") throw new Error("attachment_not_found");
    if (!/^attachments\/[a-f0-9]{2}\/[a-f0-9]{64}$/u.test(row.storage_key)) throw new Error("attachment_storage_key_invalid");
    const bytes = readFileSync(join(this.dataRoot, row.storage_key));
    if (bytes.byteLength !== row.byte_size || createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new Error("attachment_integrity_failed");
    return { record: toRecord(row), bytes };
  }

  belongsToWorkspace(id: string, workspaceId: string): boolean {
    return Boolean(this.db.query("SELECT 1 FROM attachment_sources WHERE attachment_id = ? AND workspace_id = ? LIMIT 1").get(id, workspaceId));
  }

  private linkSource(attachmentId: string, workspaceId: string, relativePath: string): void {
    this.db.query("INSERT OR IGNORE INTO attachment_sources (attachment_id, workspace_id, relative_path) VALUES (?, ?, ?)")
      .run(attachmentId, workspaceId, relativePath);
  }
}
