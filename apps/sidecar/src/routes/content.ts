import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import type { AttachmentResolver } from "../attachments/resolver";
import type { WorkspaceManager } from "../workspace/manager";
import { WorkspacePathPolicy } from "../workspace/path-policy";
import { searchWorkspacePaths } from "../workspace/search";

export function contentRoutes(db: Database, workspaces: WorkspaceManager, attachments: AttachmentResolver): Hono {
  const app = new Hono();
  app.get("/workspaces/:id/files", (c) => {
    const workspace = workspaces.get(c.req.param("id"));
    if (!workspace) return c.json({ error: "workspace_not_found" }, 404);
    return c.json(searchWorkspacePaths(workspace.canonicalPath, c.req.query("q") ?? ""));
  });
  app.post("/workspaces/:id/refs", async (c) => {
    const workspace = workspaces.get(c.req.param("id"));
    if (!workspace) return c.json({ error: "workspace_not_found" }, 404);
    const body = await c.req.json().catch(() => null) as { relativePath?: unknown } | null;
    if (typeof body?.relativePath !== "string") return c.json({ error: "relative_path_required" }, 400);
    try {
      const policy = new WorkspacePathPolicy(workspace.canonicalPath);
      const resolved = policy.resolveExisting(body.relativePath);
      const bytes = policy.readBytes(resolved.relativePath, 512 * 1024);
      const snapshotHash = bytes.truncated ? null : createHash("sha256").update(bytes.bytes).digest("hex");
      const existing = db.query<{ id: string }, [string, string]>("SELECT id FROM workspace_refs WHERE workspace_id = ? AND relative_path = ?").get(workspace.id, resolved.relativePath);
      const id = existing?.id ?? crypto.randomUUID();
      if (existing) {
        db.query("UPDATE workspace_refs SET snapshot_hash = ?, snapshot_size = ?, created_at = ? WHERE id = ?")
          .run(snapshotHash, bytes.byteSize, new Date().toISOString(), id);
      } else {
        db.query(`
          INSERT INTO workspace_refs (id, workspace_id, relative_path, kind, snapshot_hash, snapshot_size, created_at)
          VALUES (?, ?, ?, 'file', ?, ?, ?)
        `).run(id, workspace.id, resolved.relativePath, snapshotHash, bytes.byteSize, new Date().toISOString());
      }
      return c.json({ id, workspaceId: workspace.id, relativePath: resolved.relativePath, kind: "file", snapshotHash, snapshotSize: bytes.byteSize }, existing ? 200 : 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "workspace_ref_failed" }, 400);
    }
  });
  app.post("/attachments/import", async (c) => {
    const body = await c.req.json().catch(() => null) as { workspaceId?: unknown; relativePath?: unknown } | null;
    if (typeof body?.workspaceId !== "string" || typeof body.relativePath !== "string") return c.json({ error: "invalid_attachment_import" }, 400);
    const workspace = workspaces.get(body.workspaceId);
    if (!workspace) return c.json({ error: "workspace_not_found" }, 404);
    try {
      return c.json(attachments.importWorkspaceFile(workspace, body.relativePath), 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "attachment_import_failed" }, 400);
    }
  });
  app.post("/attachments/upload", async (c) => {
    const workspaceId = c.req.query("workspaceId");
    const filename = c.req.query("filename");
    if (!workspaceId || !filename) return c.json({ error: "invalid_attachment_upload" }, 400);
    if (!workspaces.get(workspaceId)) return c.json({ error: "workspace_not_found" }, 404);
    const reader = c.req.raw.body?.getReader();
    if (!reader) return c.json({ error: "attachment_body_required" }, 400);
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 25 * 1024 * 1024) {
          await reader.cancel();
          return c.json({ error: "attachment_too_large" }, 413);
        }
        chunks.push(value);
      }
      return c.json(attachments.importClipboardBytes(workspaceId, filename, Buffer.concat(chunks)), 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "attachment_upload_failed" }, 400);
    }
  });
  app.get("/attachments/:id", (c) => {
    try {
      const attachment = attachments.read(c.req.param("id"));
      const inline = attachment.record.mediaType.startsWith("image/");
      return new Response(attachment.bytes, { headers: {
        "Content-Type": attachment.record.mediaType,
        "Content-Length": String(attachment.record.byteSize),
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.record.filename)}`,
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
      } });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "attachment_not_found" }, 404);
    }
  });
  return app;
}
