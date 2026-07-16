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
  return app;
}
