import { expect, test } from "bun:test";
import { Hono } from "hono";
import { openDb } from "../db";
import { SessionStore } from "../store/session-store";
import { EventStore } from "../store/event-store";
import { sessionRoutes } from "./sessions";

test("new Chat room needs no workspace; backend refuses later workspace binding", async () => {
  const db = openDb(":memory:");
  const sessions = new SessionStore(db);
  const app = new Hono().route("/sessions", sessionRoutes(sessions, new EventStore(db)));
  const body = { kind: "chat" as const, title: "Topic", mode: "chat" as const, primaryAgentId: "a", agents: [{ agentId: "a", snapshot: {}, executionEligible: true }] };
  const created = await app.request("/sessions", { method: "POST", body: JSON.stringify(body) });
  expect(created.status).toBe(201);
  const room = await created.json();
  expect(room.kind).toBe("chat");
  expect(room.workspaceId).toBeNull();
  expect((await app.request("/sessions", { method: "POST", body: JSON.stringify({ ...body, workspaceSelection: { kind: "managed" } }) })).status).toBe(400);
  expect(() => sessions.bindWorkspace(room.id, "any")).toThrow("chat_room_must_not_bind_workspace");
  expect(() => sessions.create({ ...body, workspaceId: "any" })).toThrow("chat_room_must_not_bind_workspace");
  db.close();
});

test("server role resolver owns room snapshots and explicit refresh is idle-only", async () => {
  const db = openDb(":memory:");
  let template = { providerId: "p", modelId: "model-v1", nickname: "A" };
  const sessions = new SessionStore(db);
  const app = new Hono().route("/sessions", sessionRoutes(sessions, new EventStore(db), undefined, undefined, undefined, () => template));
  const response = await app.request("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "A", mode: "chat", primaryAgentId: "a", agents: [{ agentId: "a", snapshot: { modelId: "forged" } }] }) });
  const room = await response.json();
  expect(room.agents[0].snapshot.modelId).toBe("model-v1");
  template = { ...template, modelId: "model-v2" };
  expect(sessions.get(room.id)!.agents[0]!.snapshot.modelId).toBe("model-v1");
  expect((await app.request(`/sessions/${room.id}/agents/a/template`, { method: "PUT" })).status).toBe(200);
  expect(sessions.get(room.id)!.agents[0]!.snapshot.modelId).toBe("model-v2");
  db.run("UPDATE sessions SET status = 'running' WHERE id = ?", [room.id]);
  expect((await app.request(`/sessions/${room.id}/agents/a/template`, { method: "PUT" })).status).toBe(409);
  db.close();
});

test("room member availability exposes a reason without resolving or returning credentials", async () => {
  const db = openDb(":memory:"), sessions = new SessionStore(db);
  const room = sessions.create({ title: "Chat", mode: "chat", primaryAgentId: "a", agents: [{ agentId: "a", snapshot: { providerId: "missing" }, executionEligible: true }] });
  const app = new Hono().route("/sessions", sessionRoutes(sessions, new EventStore(db), undefined, undefined, undefined, undefined, () => "multi_provider_key_missing"));
  const response = await app.request(`/sessions/${room.id}`);
  const body = await response.json();
  expect(body.agents[0].unavailableReason).toBe("multi_provider_key_missing");
  expect(body.agents[0].snapshot).toEqual({ providerId: "missing" });
  db.close();
});
