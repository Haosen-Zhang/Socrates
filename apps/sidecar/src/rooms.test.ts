import { describe, expect, it, beforeEach } from "bun:test";
import { Hono } from "hono";
import { AGENT_AVATARS, parseSseChunk, type GatewayRequest, type ModelGateway, type StreamEvent } from "@socrates/core";
import { openDb } from "./db";
import { MemorySecrets } from "./secrets";
import { providerRoutes } from "./providers";
import { agentRoutes } from "./agents";
import { roomRoutes } from "./rooms";
import { UsageCollector } from "./services/usage-collector";

function makeApp(gateway: ModelGateway) {
  const db = openDb(":memory:");
  const secrets = new MemorySecrets();
  const app = new Hono();
  app.route("/providers", providerRoutes(db, secrets));
  app.route("/agents", agentRoutes(db));
  app.route("/rooms", roomRoutes(db, secrets, gateway, new UsageCollector(db)));
  return app;
}

const okGateway: ModelGateway = async function* () {
  yield { type: "delta", text: "你" };
  yield { type: "delta", text: "好" };
  yield { type: "done", usage: { inputTokens: 2, outputTokens: 3 } };
};

async function setupRoom(app: Hono) {
  const provider = await (
    await app.request("/providers", {
      method: "POST",
      body: JSON.stringify({ name: "DS", type: "openai_compatible", apiKey: "sk-x" }),
    })
  ).json();
  const agent = await (
    await app.request("/agents", {
      method: "POST",
      body: JSON.stringify({
        nickname: "小助手",
        avatar: AGENT_AVATARS[0],
        providerId: provider.id,
        modelId: "deepseek-v4-flash",
        systemPrompt: "你是助手",
      }),
    })
  ).json();
  const room = await (
    await app.request("/rooms", {
      method: "POST",
      body: JSON.stringify({ name: "测试房", agentIds: [agent.id] }),
    })
  ).json();
  return { provider, agent, room };
}

async function postMessage(app: Hono, roomId: string, content: string): Promise<StreamEvent[]> {
  const res = await app.request(`/rooms/${roomId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const { events, rest } = parseSseChunk(await res.text());
  expect(rest).toBe("");
  return events;
}

describe("agent & room CRUD", () => {
  let app: Hono;
  beforeEach(() => {
    app = makeApp(okGateway);
  });

  it("validates agent creation", async () => {
    const bad = await app.request("/agents", {
      method: "POST",
      body: JSON.stringify({ displayName: "x", providerId: "nope", modelId: "m" }),
    });
    expect(bad.status).toBe(400);
  });

  it("room requires at least one valid agent", async () => {
    const res = await app.request("/rooms", {
      method: "POST",
      body: JSON.stringify({ name: "空房", agentIds: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("invites another agent after the room is created", async () => {
    const { provider, room } = await setupRoom(app);
    const newcomer = await (
      await app.request("/agents", {
        method: "POST",
        body: JSON.stringify({
          nickname: "紫镜狐狸",
          avatar: AGENT_AVATARS[1],
          providerId: provider.id,
          modelId: "model-b",
        }),
      })
    ).json();
    const added = await app.request(`/rooms/${room.id}/agents`, {
      method: "POST",
      body: JSON.stringify({ agentId: newcomer.id }),
    });
    expect(added.status).toBe(201);
    const rooms = await (await app.request("/rooms")).json();
    expect(rooms[0].agentIds).toEqual([room.agentIds[0], newcomer.id]);
    expect(
      (
        await app.request(`/rooms/${room.id}/agents`, {
          method: "POST",
          body: JSON.stringify({ agentId: newcomer.id }),
        })
      ).status,
    ).toBe(409);
  });
});

describe("message flow", () => {
  it("streams deltas and persists both messages", async () => {
    const app = makeApp(okGateway);
    const { agent, room } = await setupRoom(app);
    const events = await postMessage(app, room.id, "打个招呼");

    const types = events.map((e) => e.type);
    expect(types).toEqual(["user_message", "turn_started", "delta", "delta", "message_completed"]);
    const completed = events.at(-1) as Extract<StreamEvent, { type: "message_completed" }>;
    expect(completed.message.content).toBe("你好");
    expect(completed.message.agentName).toBe("小助手");
    expect(completed.message.model).toBe("deepseek-v4-flash");
    expect(completed.message.agentId).toBe(agent.id);

    const history = await (await app.request(`/rooms/${room.id}/messages`)).json();
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe("user");
    expect(history[1].content).toBe("你好");
    expect(await (await app.request(`/rooms/${room.id}/usage`)).json()).toMatchObject([{ agentId: agent.id, current: { totalTokens: 5 }, cumulative: { totalTokens: 5 } }]);
  });

  it("passes system prompt and history to the gateway", async () => {
    const seen: GatewayRequest[] = [];
    const spy: ModelGateway = async function* (req) {
      seen.push(req);
      yield { type: "delta", text: "ok" };
      yield { type: "done" };
    };
    const app = makeApp(spy);
    const { room } = await setupRoom(app);
    await postMessage(app, room.id, "第一问");
    await postMessage(app, room.id, "第二问");

    expect(seen[0].system).toBe("你是助手");
    expect(seen[0].messages).toEqual([{ role: "user", content: "第一问" }]);
    expect(seen[1].messages).toEqual([
      { role: "user", content: "第一问" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "第二问" },
    ]);
    expect(seen[0].apiKey).toBe("sk-x");
  });

  it("emits error and does not persist agent message on gateway failure", async () => {
    const failing: ModelGateway = async function* () {
      yield { type: "delta", text: "半截" };
      yield { type: "error", message: "Incorrect API key" };
    };
    const app = makeApp(failing);
    const { room } = await setupRoom(app);
    const events = await postMessage(app, room.id, "会失败");

    expect(events.map((e) => e.type)).toContain("error");
    expect(events.map((e) => e.type)).not.toContain("message_completed");
    const history = await (await app.request(`/rooms/${room.id}/messages`)).json();
    expect(history).toHaveLength(1); // 只有用户消息
  });

  it("rejects messaging a room with no agent or missing key", async () => {
    const app = makeApp(okGateway);
    const missing = await app.request("/rooms/nope/messages", {
      method: "POST",
      body: JSON.stringify({ content: "x" }),
    });
    expect(missing.status).toBe(404);
  });
});
