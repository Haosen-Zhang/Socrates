import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { openDb } from "../db";
import { EventStore } from "../store/event-store";
import { SessionStore } from "../store/session-store";
import { sessionRoutes } from "./sessions";

describe("session routes", () => {
  it("creates a mode and replays events after a cursor", async () => {
    const db = openDb(":memory:");
    const sessions = new SessionStore(db);
    const events = new EventStore(db);
    const app = new Hono().route("/sessions", sessionRoutes(sessions, events));
    const response = await app.request("/sessions", { method: "POST", body: JSON.stringify({ title: "Chat", mode: "chat", agents: [{ agentId: "a", snapshot: { nickname: "A" }, executionEligible: false }] }) });
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
    const app = new Hono().route("/sessions", sessionRoutes(sessions, new EventStore(db)));
    const created = await (await app.request("/sessions", { method: "POST", body: JSON.stringify({ title: "Draft", mode: "chat", agents: [{ agentId: "a", snapshot: { nickname: "A" }, executionEligible: false }] }) })).json() as { id: string };
    const renamed = await app.request(`/sessions/${created.id}`, { method: "PUT", body: JSON.stringify({ title: "Renamed" }) });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).title).toBe("Renamed");
    const archived = await app.request(`/sessions/${created.id}/archive`, { method: "PUT", body: JSON.stringify({ archived: true }) });
    expect(archived.status).toBe(200);
    expect((await archived.json()).archived).toBe(true);
  });
});
