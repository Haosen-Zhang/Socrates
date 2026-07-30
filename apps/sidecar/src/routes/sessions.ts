import { Hono } from "hono";
import {
  COLLABORATION_RUNTIME_CAPABILITIES,
  DEFAULT_COLLABORATION_SETTINGS,
  isToolApprovalMode,
  normalizeCollaborationSettings,
  validateCollaborationCapabilities,
  type ConversationMode,
  type RoomCollaborationSettings,
} from "@socrates/core";
import type { SessionStore } from "../store/session-store";
import type { EventStore } from "../store/event-store";
import type { UsageCollector } from "../services/usage-collector";
import type { WorkspaceManager } from "../workspace/manager";

const MODES = new Set<ConversationMode>(["chat", "single_agent", "multi_agent"]);

export function sessionRoutes(
  sessions: SessionStore,
  events: EventStore,
  usage?: UsageCollector,
  workspaces?: WorkspaceManager,
  collaborationDefaults: () => RoomCollaborationSettings =
    () => DEFAULT_COLLABORATION_SETTINGS,
): Hono {
  const app = new Hono();
  app.get("/", (c) => c.json(sessions.list()));
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.title !== "string" || typeof body.mode !== "string" || !MODES.has(body.mode as ConversationMode) || !Array.isArray(body.agents) || typeof body.primaryAgentId !== "string") {
      return c.json({ error: "invalid_session_input" }, 400);
    }
    const workspaceSelection = body.workspaceSelection && typeof body.workspaceSelection === "object"
      ? body.workspaceSelection as Record<string, unknown>
      : null;
    if (!workspaceSelection) {
      return c.json({ error: "workspace_selection_required" }, 400);
    }
    const sessionId = crypto.randomUUID();
    let managedWorkspaceCreated = false;
    try {
      let workspaceId: string;
      if (workspaceSelection?.kind === "managed") {
        if (!workspaces) throw new Error("managed_workspace_unavailable");
        workspaceId = workspaces.createManaged(sessionId, body.title).id;
        managedWorkspaceCreated = true;
      } else if (workspaceSelection?.kind === "existing") {
        if (typeof workspaceSelection.workspaceId !== "string") throw new Error("workspace_required");
        workspaceId = workspaceSelection.workspaceId;
      } else {
        throw new Error("invalid_workspace_selection");
      }
      const defaults = normalizeCollaborationSettings(collaborationDefaults());
      const capabilityErrors = validateCollaborationCapabilities(defaults);
      if (capabilityErrors.length) throw new Error(capabilityErrors[0]);
      return c.json(sessions.create({
        id: sessionId,
        title: body.title,
        mode: body.mode as ConversationMode,
        kind: "cowork",
        workspaceId,
        primaryAgentId: body.primaryAgentId,
        collaborationDefaults: defaults,
        agents: body.agents as Array<{ agentId: string; snapshot: Record<string, unknown>; executionEligible: boolean }>,
      }), 201);
    } catch (error) {
      if (managedWorkspaceCreated) workspaces?.discardManaged(sessionId);
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
    const body = await c.req.json().catch(() => null) as {
      collaboration?: unknown;
      primaryAgentId?: unknown;
    } | null;
    if (!body || typeof body.collaboration !== "object" || body.collaboration === null) return c.json({ error: "invalid_collaboration_input" }, 400);
    try {
      const normalized = normalizeCollaborationSettings(body.collaboration);
      const capabilityErrors = validateCollaborationCapabilities(
        normalized,
        COLLABORATION_RUNTIME_CAPABILITIES,
      );
      if (capabilityErrors.length) throw new Error(capabilityErrors[0]);
      if (body.primaryAgentId !== undefined && typeof body.primaryAgentId !== "string") {
        throw new Error("invalid_primary_agent_input");
      }
      return c.json(sessions.updateCollaboration(
        c.req.param("id"),
        normalized,
        body.primaryAgentId as string | undefined,
      ));
    } catch (error) {
      const message = error instanceof Error ? error.message : "collaboration_update_failed";
      return c.json(
        { error: message },
        message === "session_not_found"
          ? 404
          : message === "collaboration_strategy_unavailable"
              || message === "discussion_runtime_unavailable"
              || message === "routing_runtime_unavailable"
              || message === "plan_confirmation_unavailable"
              || message === "active_session_collaboration_locked"
            ? 409
            : 400,
      );
    }
  });
  app.put("/:id/primary-agent", async (c) => {
    const body = await c.req.json().catch(() => null) as { primaryAgentId?: unknown } | null;
    if (typeof body?.primaryAgentId !== "string") {
      return c.json({ error: "invalid_primary_agent_input" }, 400);
    }
    try {
      return c.json(sessions.updatePrimaryAgent(c.req.param("id"), body.primaryAgentId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "primary_agent_update_failed";
      return c.json({ error: message }, message === "session_not_found" ? 404 : 409);
    }
  });
  app.post("/:id/collaboration/restore-defaults", (c) => {
    try {
      const defaults = normalizeCollaborationSettings(collaborationDefaults());
      const capabilityErrors = validateCollaborationCapabilities(defaults);
      if (capabilityErrors.length) throw new Error(capabilityErrors[0]);
      return c.json(sessions.restoreCollaborationDefaults(c.req.param("id"), defaults));
    } catch (error) {
      const message = error instanceof Error ? error.message : "collaboration_restore_failed";
      return c.json({ error: message }, message === "session_not_found" ? 404 : 409);
    }
  });
  app.put("/:id/approval-policy", async (c) => {
    const body = await c.req.json().catch(() => null) as { mode?: unknown } | null;
    if (!isToolApprovalMode(body?.mode)) {
      return c.json({ error: "invalid_approval_policy" }, 400);
    }
    try {
      return c.json(sessions.updateApprovalPolicy(c.req.param("id"), body.mode));
    } catch (error) {
      const message = error instanceof Error ? error.message : "approval_policy_update_failed";
      return c.json({ error: message }, message === "session_not_found" ? 404 : 409);
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
      const sessionId = c.req.param("id");
      const session = sessions.get(sessionId);
      if (!session) throw new Error("session_not_found");
      const workspace = session.workspaceId ? workspaces?.get(session.workspaceId) : null;
      const owned = workspace?.ownership === "managed" && workspace.ownerSessionId === sessionId;
      const workspaceFiles = c.req.query("workspaceFiles");
      if (owned && workspaceFiles !== "keep" && workspaceFiles !== "delete") {
        throw new Error("managed_workspace_retention_required");
      }
      if (owned && workspaceFiles === "delete") {
        const staged = workspaces!.stageManagedDeletion(workspace.id, sessionId);
        try {
          sessions.remove(sessionId, staged.forgetRecord);
        } catch (error) {
          staged.rollback();
          throw error;
        }
        staged.finalize();
      } else {
        sessions.remove(
          sessionId,
          owned ? () => { workspaces!.releaseManaged(workspace.id, sessionId); } : undefined,
        );
      }
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
