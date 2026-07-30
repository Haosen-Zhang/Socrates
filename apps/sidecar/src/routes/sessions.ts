import { Hono } from "hono";
import type { ConversationMode, RoomCollaborationSettings } from "@socrates/core";
import type { SessionStore } from "../store/session-store";
import type { EventStore } from "../store/event-store";
import type { UsageCollector } from "../services/usage-collector";

const MODES = new Set<ConversationMode>(["chat", "single_agent", "multi_agent"]);

export function sessionRoutes(sessions: SessionStore, events: EventStore, usage?: UsageCollector): Hono {
  const app = new Hono();
  app.get("/", (c) => c.json(sessions.list()));
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.title !== "string" || typeof body.mode !== "string" || !MODES.has(body.mode as ConversationMode) || !Array.isArray(body.agents) || typeof body.primaryAgentId !== "string") {
      return c.json({ error: "invalid_session_input" }, 400);
    }
    try {
      return c.json(sessions.create({
        title: body.title,
        mode: body.mode as ConversationMode,
        // kind 缺省时由 store 从 mode 推导；chat 的 workspaceId 也在 store 里强制置空
        kind: body.kind === "chat" || body.kind === "cowork" ? body.kind : undefined,
        workspaceId: typeof body.workspaceId === "string" ? body.workspaceId : null,
        primaryAgentId: body.primaryAgentId,
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
  app.get("/:id/usage", (c) => {
    const session = sessions.get(c.req.param("id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    return c.json(usage?.sessionSummaries(session.id) ?? []);
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
  app.post("/:id/agents", async (c) => {
    const body = await c.req.json().catch(() => null) as { agentId?: unknown; snapshot?: unknown } | null;
    if (!body || typeof body.agentId !== "string" || typeof body.snapshot !== "object" || body.snapshot === null) return c.json({ error: "invalid_member_input" }, 400);
    try {
      return c.json(sessions.addAgent(c.req.param("id"), body.agentId, body.snapshot as Record<string, unknown>));
    } catch (error) {
      const message = error instanceof Error ? error.message : "session_add_member_failed";
      return c.json({ error: message }, message === "session_not_found" ? 404 : 409);
    }
  });
  app.delete("/:id/agents/:agentId", (c) => {
    try {
      return c.json(sessions.removeAgent(c.req.param("id"), c.req.param("agentId")));
    } catch (error) {
      const message = error instanceof Error ? error.message : "session_remove_member_failed";
      return c.json({ error: message }, message === "session_not_found" ? 404 : 409);
    }
  });
  app.put("/:id/collaboration", async (c) => {
    const body = await c.req.json().catch(() => null) as { collaboration?: unknown } | null;
    if (!body || typeof body.collaboration !== "object" || body.collaboration === null) return c.json({ error: "invalid_collaboration_input" }, 400);
    try {
      return c.json(sessions.updateCollaboration(c.req.param("id"), body.collaboration as RoomCollaborationSettings));
    } catch (error) {
      const message = error instanceof Error ? error.message : "collaboration_update_failed";
      return c.json({ error: message }, message === "session_not_found" ? 404 : 400);
    }
  });
  app.put("/:id", async (c) => {
    const body = await c.req.json().catch(() => null) as { title?: unknown } | null;
    if (typeof body?.title !== "string") return c.json({ error: "session_title_required" }, 400);
    try {
      return c.json(sessions.rename(c.req.param("id"), body.title));
    } catch (error) {
      const message = error instanceof Error ? error.message : "session_rename_failed";
      return c.json({ error: message }, message === "session_not_found" ? 404 : 400);
    }
  });
  app.put("/:id/archive", async (c) => {
    const body = await c.req.json().catch(() => null) as { archived?: unknown } | null;
    if (typeof body?.archived !== "boolean") return c.json({ error: "invalid_session_archive" }, 400);
    try {
      return c.json(sessions.archive(c.req.param("id"), body.archived));
    } catch (error) {
      const message = error instanceof Error ? error.message : "session_archive_failed";
      return c.json({ error: message }, message === "session_not_found" ? 404 : 409);
    }
  });
  app.delete("/:id", (c) => {
    try {
      sessions.remove(c.req.param("id"));
      return c.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "session_delete_failed";
      return c.json({ error: message }, message === "session_not_found" ? 404 : 409);
    }
  });
  app.post("/:id/rewind", async (c) => {
    const body = await c.req.json().catch(() => null) as { messageId?: unknown } | null;
    if (typeof body?.messageId !== "string") return c.json({ error: "session_message_not_found" }, 400);
    try {
      sessions.rewind(c.req.param("id"), body.messageId);
      return c.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "session_rewind_failed";
      return c.json({ error: message }, message === "session_not_found" || message === "session_message_not_found" ? 404 : 409);
    }
  });
  app.get("/:id/events", (c) => {
    const after = Number.parseInt(c.req.query("after") ?? "0", 10);
    if (!Number.isSafeInteger(after) || after < 0) return c.json({ error: "invalid_event_cursor" }, 400);
    return c.json(events.listAfter(c.req.param("id"), after));
  });
  return app;
}
