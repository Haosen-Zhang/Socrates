import { expect, test } from "bun:test";
import { Hono } from "hono";
import { openDb } from "../db";
import { SessionStore } from "../store/session-store";
import { RoomCommandService } from "../services/room-command-service";
import { roomCommandRoutes } from "./room-commands";

test("command route validates mentions and replays persistent discussion after a cursor", async () => {
  const db = openDb(":memory:");
  const sessions = new SessionStore(db);
  const room = sessions.create({ title: "Chat", mode: "chat", primaryAgentId: "a", agents: [{ agentId: "a", snapshot: {}, executionEligible: true }] });
  const service = new RoomCommandService(db, sessions, {
    startDirect: async () => ({ runId: "r" }), getDirect: () => null, createTeam: async () => ({ taskId: "t" }),
    resolveAgent: (id) => ({ id, nickname: id, modelId: "m", role: "", systemPrompt: "", providerType: "openai_compatible", baseUrl: "", apiKey: "mock" }),
    gateway: async function* () { yield { type: "delta", text: "reply" }; yield { type: "done" }; },
  });
  const app = new Hono().route("/room-commands", roomCommandRoutes(service));
  const body = { roomId: room.id, clientRequestId: "key", content: "Hi", mentions: [{ type: "all" }], intent: "respond" };
  const response = await app.request("/room-commands", { method: "POST", body: JSON.stringify(body) });
  expect(response.status).toBe(202);
  const command = await response.json();
  await service.wait(command.commandId);
  const stream = await app.request(`/room-commands/${command.commandId}/events?afterSeq=1`);
  const text = await stream.text();
  expect(text).toContain('"type":"completed"');
  expect(text).not.toContain('id: 1\n');
  expect((await app.request(`/room-commands/${command.commandId}/events?afterSeq=-1`)).status).toBe(400);
  expect((await app.request("/room-commands", { method: "POST", body: JSON.stringify({ ...body, mentions: [null] }) })).status).toBe(400);
  expect((await (await app.request(`/room-commands/rooms/${room.id}`)).json())[0].commandId).toBe(command.commandId);
  await sessions.rewind(room.id, sessions.listMessages(room.id).find(message => message.role === "user")!.id);
  expect((await app.request(`/room-commands/${command.commandId}/events`)).status).toBe(410);
  expect((await (await app.request(`/room-commands/${command.commandId}`)).json()).status).toBe("revoked");
  db.close();
});
