import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { openDb } from "../db";
import { EventStore } from "../store/event-store";
import { SessionStore } from "../store/session-store";
import { WorkspaceManager } from "../workspace/manager";
import { sessionRoutes } from "./sessions";
import { DEFAULT_COLLABORATION_SETTINGS } from "@socrates/core";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("session routes", () => {
  it("copies global defaults, keeps room edits isolated, restores, and gates unavailable strategies", async () => {
    const db = openDb(":memory:");
    const managedRoot = `${tmpdir()}/socrates-session-defaults-${crypto.randomUUID()}`;
    roots.push(managedRoot);
    const defaults = {
      ...DEFAULT_COLLABORATION_SETTINGS,
      strategy: "team" as const,
    };
    const app = new Hono().route(
      "/sessions",
      sessionRoutes(
        new SessionStore(db),
        new EventStore(db),
        undefined,
        new WorkspaceManager(db, managedRoot),
        () => defaults,
      ),
    );
    const response = await app.request("/sessions", {
      method: "POST",
      body: JSON.stringify({
        title: "Defaults",
        mode: "multi_agent",
        primaryAgentId: "b",
        agents: [
          { agentId: "a", snapshot: {}, executionEligible: true },
          { agentId: "b", snapshot: {}, executionEligible: true },
        ],
        workspaceSelection: { kind: "managed" },
      }),
    });
    const created = await response.json();
    expect(created.collaboration.strategy).toBe("team");
    expect(created.collaboration.assignment.coordinatorAgentId).toBe("b");

    const primary = await app.request(`/sessions/${created.id}/primary-agent`, {
      method: "PUT",
      body: JSON.stringify({ primaryAgentId: "a" }),
    });
    expect((await primary.json()).primaryAgentId).toBe("a");

    const roomEdit = {
      ...created.collaboration,
      strategy: "single",
    };
    expect((await app.request(`/sessions/${created.id}/collaboration`, {
      method: "PUT",
      body: JSON.stringify({ collaboration: roomEdit }),
    })).status).toBe(200);
    expect(defaults.strategy).toBe("team");

    const restored = await app.request(
      `/sessions/${created.id}/collaboration/restore-defaults`,
      { method: "POST" },
    );
    expect((await restored.json()).collaboration.strategy).toBe("team");

    const unavailable = await app.request(`/sessions/${created.id}/collaboration`, {
      method: "PUT",
      body: JSON.stringify({
        collaboration: { ...created.collaboration, strategy: "adaptive" },
      }),
    });
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toEqual({
      error: "collaboration_strategy_unavailable",
    });

    const unavailableRouting = await app.request(`/sessions/${created.id}/collaboration`, {
      method: "PUT",
      body: JSON.stringify({
        collaboration: {
          ...created.collaboration,
          assignment: {
            ...created.collaboration.assignment,
            routing: {
              ...created.collaboration.assignment.routing,
              mode: "manual",
            },
          },
        },
      }),
    });
    expect(unavailableRouting.status).toBe(409);
    expect(await unavailableRouting.json()).toEqual({
      error: "routing_runtime_unavailable",
    });
  });

  it("rejects room creation when configured defaults exceed backend capabilities", async () => {
    const db = openDb(":memory:");
    const managedRoot = `${tmpdir()}/socrates-session-capabilities-${crypto.randomUUID()}`;
    roots.push(managedRoot);
    const app = new Hono().route(
      "/sessions",
      sessionRoutes(
        new SessionStore(db),
        new EventStore(db),
        undefined,
        new WorkspaceManager(db, managedRoot),
        () => ({ ...DEFAULT_COLLABORATION_SETTINGS, strategy: "adaptive" }),
      ),
    );
    const response = await app.request("/sessions", {
      method: "POST",
      body: JSON.stringify({
        title: "Unavailable defaults",
        mode: "single_agent",
        primaryAgentId: "a",
        agents: [{ agentId: "a", snapshot: {}, executionEligible: true }],
        workspaceSelection: { kind: "managed" },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "collaboration_strategy_unavailable",
    });
  });

  it("creates unified rooms with managed or existing workspaces and an explicit primary Agent", async () => {
    const db = openDb(":memory:");
    const managedRoot = `${tmpdir()}/socrates-session-managed-${crypto.randomUUID()}`;
    const existingRoot = `${tmpdir()}/socrates-session-existing-${crypto.randomUUID()}`;
    roots.push(managedRoot, existingRoot);
    mkdirSync(existingRoot, { recursive: true });
    const workspaces = new WorkspaceManager(db, managedRoot);
    const existing = workspaces.select(existingRoot);
    const app = new Hono().route(
      "/sessions",
      sessionRoutes(new SessionStore(db), new EventStore(db), undefined, workspaces),
    );
    const agent = { agentId: "a", snapshot: { nickname: "A" }, executionEligible: true };

    const managedResponse = await app.request("/sessions", {
      method: "POST",
      body: JSON.stringify({
        title: "Managed",
        mode: "single_agent",
        primaryAgentId: "a",
        agents: [agent],
        workspaceSelection: { kind: "managed" },
      }),
    });
    expect(managedResponse.status).toBe(201);
    const managed = await managedResponse.json();
    expect(managed).toMatchObject({
      kind: "cowork",
      mode: "single_agent",
      primaryAgentId: "a",
    });
    const managedWorkspace = workspaces.get(managed.workspaceId);
    expect(managedWorkspace).toMatchObject({
      ownership: "managed",
      ownerSessionId: managed.id,
    });
    expect(managedWorkspace?.canonicalPath).toBe(realpathSync(`${managedRoot}/${managed.id}`));
    expect(existsSync(managedWorkspace!.canonicalPath)).toBe(true);

    const existingResponse = await app.request("/sessions", {
      method: "POST",
      body: JSON.stringify({
        title: "Existing",
        mode: "single_agent",
        primaryAgentId: "a",
        agents: [agent],
        workspaceSelection: { kind: "existing", workspaceId: existing.id },
      }),
    });
    expect(existingResponse.status).toBe(201);
    expect((await existingResponse.json()).workspaceId).toBe(existing.id);

    const legacyWorkspaceLess = await app.request("/sessions", {
      method: "POST",
      body: JSON.stringify({
        title: "Legacy",
        mode: "chat",
        kind: "chat",
        primaryAgentId: "a",
        agents: [agent],
      }),
    });
    expect(legacyWorkspaceLess.status).toBe(400);
    expect(await legacyWorkspaceLess.json()).toEqual({ error: "workspace_selection_required" });
  });

  it("rejects binding another room's managed workspace as an existing project", async () => {
    const db = openDb(":memory:");
    const managedRoot = `${tmpdir()}/socrates-session-managed-isolation-${crypto.randomUUID()}`;
    roots.push(managedRoot);
    const workspaces = new WorkspaceManager(db, managedRoot);
    const managed = workspaces.createManaged("owner-room", "Owner room");
    const app = new Hono().route(
      "/sessions",
      sessionRoutes(new SessionStore(db), new EventStore(db), undefined, workspaces),
    );

    const response = await app.request("/sessions", {
      method: "POST",
      body: JSON.stringify({
        title: "Intruder",
        mode: "single_agent",
        primaryAgentId: "a",
        agents: [{ agentId: "a", snapshot: {}, executionEligible: true }],
        workspaceSelection: { kind: "existing", workspaceId: managed.id },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "existing_workspace_required" });
  });

  it("requires an explicit file-retention choice when deleting a managed room", async () => {
    const db = openDb(":memory:");
    const managedRoot = `${tmpdir()}/socrates-session-delete-${crypto.randomUUID()}`;
    roots.push(managedRoot);
    const workspaces = new WorkspaceManager(db, managedRoot);
    const app = new Hono().route(
      "/sessions",
      sessionRoutes(new SessionStore(db), new EventStore(db), undefined, workspaces),
    );
    const create = async (title: string) => (await (await app.request("/sessions", {
      method: "POST",
      body: JSON.stringify({
        title,
        mode: "single_agent",
        primaryAgentId: "a",
        agents: [{ agentId: "a", snapshot: {}, executionEligible: true }],
        workspaceSelection: { kind: "managed" },
      }),
    })).json()) as { id: string; workspaceId: string };

    const kept = await create("Keep");
    const keptPath = workspaces.get(kept.workspaceId)!.canonicalPath;
    const missingChoice = await app.request(`/sessions/${kept.id}`, { method: "DELETE" });
    expect(missingChoice.status).toBe(409);
    expect(await missingChoice.json()).toEqual({ error: "managed_workspace_retention_required" });
    expect((await app.request(`/sessions/${kept.id}`)).status).toBe(200);

    expect((await app.request(`/sessions/${kept.id}?workspaceFiles=keep`, { method: "DELETE" })).status)
      .toBe(200);
    expect(existsSync(keptPath)).toBe(true);
    expect(workspaces.get(kept.workspaceId)).toMatchObject({
      ownership: "external",
      ownerSessionId: null,
    });

    const removed = await create("Remove");
    const removedPath = workspaces.get(removed.workspaceId)!.canonicalPath;
    expect((await app.request(`/sessions/${removed.id}?workspaceFiles=delete`, { method: "DELETE" })).status)
      .toBe(200);
    expect(existsSync(removedPath)).toBe(false);
    expect(workspaces.get(removed.workspaceId)).toBeNull();

    const active = await create("Active");
    const activePath = workspaces.get(active.workspaceId)!.canonicalPath;
    db.query("UPDATE sessions SET status = 'running' WHERE id = ?").run(active.id);
    const rejected = await app.request(
      `/sessions/${active.id}?workspaceFiles=delete`,
      { method: "DELETE" },
    );
    expect(rejected.status).toBe(409);
    expect(existsSync(activePath)).toBe(true);
    expect(workspaces.get(active.workspaceId)).not.toBeNull();
    expect((await app.request(`/sessions/${active.id}`)).status).toBe(200);
  });

  it("creates a mode and replays events after a cursor", async () => {
    const db = openDb(":memory:");
    const sessions = new SessionStore(db);
    const events = new EventStore(db);
    const managedRoot = `${tmpdir()}/socrates-session-events-${crypto.randomUUID()}`;
    roots.push(managedRoot);
    const app = new Hono().route(
      "/sessions",
      sessionRoutes(sessions, events, undefined, new WorkspaceManager(db, managedRoot)),
    );
    const response = await app.request("/sessions", { method: "POST", body: JSON.stringify({ title: "Chat", mode: "chat", primaryAgentId: "a", agents: [{ agentId: "a", snapshot: { nickname: "A" }, executionEligible: false }], workspaceSelection: { kind: "managed" } }) });
    expect(response.status).toBe(201);
    const session = await response.json();
    events.append({ eventId: "e1", sessionId: session.id, type: "first", payload: {} });
    events.append({ eventId: "e2", sessionId: session.id, type: "second", payload: {} });
    const replay = await (await app.request(`/sessions/${session.id}/events?after=1`)).json();
    expect(replay.map((event: { eventId: string }) => event.eventId)).toEqual(["e2"]);
  });

  it("renames and archives an inactive session through the API", async () => {
    const db = openDb(":memory:");
    const sessions = new SessionStore(db);
    const managedRoot = `${tmpdir()}/socrates-session-rename-${crypto.randomUUID()}`;
    roots.push(managedRoot);
    const app = new Hono().route("/sessions", sessionRoutes(sessions, new EventStore(db), undefined, new WorkspaceManager(db, managedRoot)));
    const created = await (await app.request("/sessions", { method: "POST", body: JSON.stringify({ title: "Draft", mode: "chat", primaryAgentId: "a", agents: [{ agentId: "a", snapshot: { nickname: "A" }, executionEligible: false }], workspaceSelection: { kind: "managed" } }) })).json() as { id: string };
    const renamed = await app.request(`/sessions/${created.id}`, { method: "PUT", body: JSON.stringify({ title: "Renamed" }) });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).title).toBe("Renamed");
    const archived = await app.request(`/sessions/${created.id}/archive`, { method: "PUT", body: JSON.stringify({ archived: true }) });
    expect(archived.status).toBe(200);
    expect((await archived.json()).archived).toBe(true);
  });

  it("updates only the selected room approval policy through the API", async () => {
    const db = openDb(":memory:");
    const sessions = new SessionStore(db);
    const managedRoot = `${tmpdir()}/socrates-session-policy-${crypto.randomUUID()}`;
    roots.push(managedRoot);
    const app = new Hono().route("/sessions", sessionRoutes(sessions, new EventStore(db), undefined, new WorkspaceManager(db, managedRoot)));
    const created = await (await app.request("/sessions", {
      method: "POST",
      body: JSON.stringify({
        title: "Policy",
        mode: "chat",
        primaryAgentId: "a",
        agents: [{ agentId: "a", snapshot: {}, executionEligible: false }],
        workspaceSelection: { kind: "managed" },
      }),
    })).json() as { id: string };

    const response = await app.request(`/sessions/${created.id}/approval-policy`, {
      method: "PUT",
      body: JSON.stringify({ mode: "auto_safe" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).approvalPolicy).toEqual({ mode: "auto_safe", version: 2 });

    const invalid = await app.request(`/sessions/${created.id}/approval-policy`, {
      method: "PUT",
      body: JSON.stringify({ mode: "unrestricted" }),
    });
    expect(invalid.status).toBe(400);
  });

  it("rejects session creation without an explicit primary Agent", async () => {
    const db = openDb(":memory:");
    const managedRoot = `${tmpdir()}/socrates-session-invalid-${crypto.randomUUID()}`;
    roots.push(managedRoot);
    const app = new Hono().route(
      "/sessions",
      sessionRoutes(new SessionStore(db), new EventStore(db), undefined, new WorkspaceManager(db, managedRoot)),
    );
    const response = await app.request("/sessions", {
      method: "POST",
      body: JSON.stringify({
        title: "Implicit",
        mode: "chat",
        agents: [{ agentId: "a", snapshot: {}, executionEligible: false }],
        workspaceSelection: { kind: "managed" },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_session_input" });
  });
});
