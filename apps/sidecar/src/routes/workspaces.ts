import { Hono } from "hono";
import type { WorkspaceManager } from "../workspace/manager";

export function workspaceRoutes(manager: WorkspaceManager): Hono {
  const app = new Hono();
  app.get("/", (c) => c.json(manager.listRecent()));
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null) as { path?: unknown } | null;
    if (typeof body?.path !== "string" || !body.path.trim()) return c.json({ error: "workspace_path_required" }, 400);
    try {
      return c.json(manager.select(body.path), 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : "workspace_selection_failed";
      return c.json({ error: message }, message === "workspace_not_found" ? 404 : 400);
    }
  });
  app.get("/:id", (c) => {
    const workspace = manager.get(c.req.param("id"));
    return workspace ? c.json(workspace) : c.json({ error: "workspace_not_found" }, 404);
  });
  app.put("/:id", async (c) => {
    const body = await c.req.json().catch(() => null) as { label?: unknown } | null;
    if (typeof body?.label !== "string") return c.json({ error: "workspace_label_required" }, 400);
    try {
      return c.json(manager.rename(c.req.param("id"), body.label));
    } catch (error) {
      const message = error instanceof Error ? error.message : "workspace_rename_failed";
      return c.json({ error: message }, message === "workspace_not_found" ? 404 : 400);
    }
  });
  app.put("/:id/archive", async (c) => {
    const body = await c.req.json().catch(() => null) as { archived?: unknown } | null;
    if (typeof body?.archived !== "boolean") return c.json({ error: "invalid_workspace_archive" }, 400);
    try {
      return c.json(manager.archive(c.req.param("id"), body.archived));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "workspace_archive_failed" }, 404);
    }
  });
  app.delete("/:id", (c) => {
    try {
      manager.remove(c.req.param("id"));
      return c.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "workspace_remove_failed";
      return c.json({ error: message }, message === "workspace_not_found" ? 404 : 409);
    }
  });
  return app;
}
