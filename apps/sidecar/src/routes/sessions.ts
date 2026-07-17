import { Hono } from "hono";
import type { ConversationMode } from "@socrates/core";
import type { SessionStore } from "../store/session-store";
import type { EventStore } from "../store/event-store";

const MODES = new Set<ConversationMode>(["chat", "single_agent", "multi_agent"]);

export function sessionRoutes(sessions: SessionStore, events: EventStore): Hono {
  const app = new Hono();
  app.get("/", (c) => c.json(sessions.list()));
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.title !== "string" || typeof body.mode !== "string" || !MODES.has(body.mode as ConversationMode) || !Array.isArray(body.agents)) {
      return c.json({ error: "invalid_session_input" }, 400);
    }
    try {
      return c.json(sessions.create({
        title: body.title,
        mode: body.mode as ConversationMode,
        workspaceId: typeof body.workspaceId === "string" ? body.workspaceId : null,
        agents: body.agents as Array<{ agentId: string; snapshot: Record<string, unknown>; executionEligible: boolean }>,
      }), 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "session_create_failed" }, 400);
    }
  });
  app.get("/:id", (c) => {
    const session = sessions.get(c.req.param("id"));
    return session ? c.json(session) : c.json({ error: "session_not_found" }, 404);
  });
  app.get("/:id/messages", (c) => {
    const session = sessions.get(c.req.param("id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    return c.json(sessions.listMessages(session.id));
  });
  app.put("/:id/workspace", async (c) => {
    const body = await c.req.json().catch(() => null) as { workspaceId?: unknown } | null;
    if (body?.workspaceId !== null && typeof body?.workspaceId !== "string") return c.json({ error: "invalid_workspace_binding" }, 400);
    try {
      return c.json(sessions.bindWorkspace(c.req.param("id"), body.workspaceId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "workspace_bind_failed";
      return c.json({ error: message }, message === "session_not_found" ? 404 : 409);
    }
  });
  app.get("/:id/events", (c) => {
    const after = Number.parseInt(c.req.query("after") ?? "0", 10);
    if (!Number.isSafeInteger(after) || after < 0) return c.json({ error: "invalid_event_cursor" }, 400);
    return c.json(events.listAfter(c.req.param("id"), after));
  });
  return app;
}
