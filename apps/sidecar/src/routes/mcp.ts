import { Hono } from "hono";
import type { McpServerInput } from "@socrates/core";
import type { McpStore } from "../mcp/store";

export type McpLifecycle = {
  connect(id: string): Promise<void>;
  disconnect(id: string): Promise<void>;
};

export function mcpRoutes(store: McpStore, lifecycle?: McpLifecycle): Hono {
  const app = new Hono();
  app.get("/servers", (c) => c.json(store.list(c.req.query("workspaceId"))));
  app.get("/export", (c) => c.json(store.exportRedacted(c.req.query("workspaceId"))));
  app.get("/servers/:id/tools", (c) => c.json(store.listTools(c.req.param("id"))));
  app.get("/servers/:id/catalog", (c) => c.json(store.listCatalog(c.req.param("id"))));
  app.get("/servers/:id/diagnostics", (c) => {
    try { return c.json(store.diagnostics(c.req.param("id"))); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : "mcp_diagnostics_failed" }, 404); }
  });
  app.put("/servers/:id/tools/:tool/policy", async (c) => {
    const body = await c.req.json().catch(() => null) as { effect?: unknown; riskOverride?: unknown } | null;
    if (!body || !["allow", "ask", "deny"].includes(String(body.effect))) return c.json({ error: "mcp_policy_invalid" }, 400);
    if (body.riskOverride != null && !["low", "medium", "high", "destructive"].includes(String(body.riskOverride))) return c.json({ error: "mcp_risk_invalid" }, 400);
    try {
      store.setToolPolicy(c.req.param("id"), decodeURIComponent(c.req.param("tool")), {
        effect: body.effect as "allow" | "ask" | "deny",
        riskOverride: typeof body.riskOverride === "string" ? body.riskOverride as "low" | "medium" | "high" | "destructive" : null,
      });
      return c.json({ ok: true });
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : "mcp_policy_failed" }, 400); }
  });
  app.post("/servers", async (c) => {
    const body = await c.req.json().catch(() => null) as { server?: McpServerInput; secrets?: Record<string, string> } | null;
    try { return c.json(store.create(body?.server as McpServerInput, body?.secrets), 201); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : "mcp_create_failed" }, 400); }
  });
  app.put("/servers/:id", async (c) => {
    const body = await c.req.json().catch(() => null) as { server?: McpServerInput; secrets?: Record<string, string> } | null;
    try {
      await lifecycle?.disconnect(c.req.param("id"));
      const updated = store.update(c.req.param("id"), body?.server as McpServerInput, body?.secrets);
      if (updated.enabled) await lifecycle?.connect(updated.id);
      return c.json(store.get(updated.id));
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : "mcp_update_failed" }, 400); }
  });
  app.put("/servers/:id/enabled", async (c) => {
    const body = await c.req.json().catch(() => null) as { enabled?: unknown } | null;
    if (typeof body?.enabled !== "boolean") return c.json({ error: "mcp_enabled_required" }, 400);
    try {
      const server = store.setEnabled(c.req.param("id"), body.enabled);
      if (body.enabled) await lifecycle?.connect(server.id); else await lifecycle?.disconnect(server.id);
      return c.json(store.get(server.id));
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : "mcp_enable_failed" }, 400); }
  });
  app.post("/servers/:id/test", async (c) => {
    try {
      await lifecycle?.connect(c.req.param("id"));
      const tested = store.get(c.req.param("id"));
      if (!tested?.enabled) await lifecycle?.disconnect(c.req.param("id"));
      return c.json(tested);
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : "mcp_test_failed" }, 400); }
  });
  app.delete("/servers/:id", async (c) => {
    try {
      await lifecycle?.disconnect(c.req.param("id"));
      store.remove(c.req.param("id"));
      return c.json({ ok: true });
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : "mcp_delete_failed" }, 404); }
  });
  return app;
}
