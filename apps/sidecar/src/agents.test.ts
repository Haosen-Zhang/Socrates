import { beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { AGENT_AVATARS } from "@socrates/core";
import { openDb } from "./db";
import { MemorySecrets } from "./secrets";
import { providerRoutes } from "./providers";
import { agentRoutes } from "./agents";

function makeApp() {
  const db = openDb(":memory:");
  const app = new Hono();
  app.route("/providers", providerRoutes(db, new MemorySecrets()));
  app.route("/agents", agentRoutes(db));
  return app;
}

async function createProvider(app: Hono): Promise<string> {
  const response = await app.request("/providers", {
    method: "POST",
    body: JSON.stringify({ name: "OpenAI", type: "openai_compatible", apiKey: "sk-test" }),
  });
  return (await response.json()).id;
}

async function createAgent(app: Hono, providerId: string, nickname: string, avatar: string = AGENT_AVATARS[0]) {
  return app.request("/agents", {
    method: "POST",
    body: JSON.stringify({ nickname, avatar, providerId, modelId: "test-model" }),
  });
}

describe("agent identity validation", () => {
  let app: Hono;
  let providerId: string;

  beforeEach(async () => {
    app = makeApp();
    providerId = await createProvider(app);
  });

  it("rejects duplicate nicknames after whitespace, width, and case normalization", async () => {
    expect((await createAgent(app, providerId, "Alice Smith")).status).toBe(201);
    const duplicate = await createAgent(app, providerId, "  ＡLICE   SMITH  ");
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "昵称已被使用" });
  });

  it("rejects renaming an agent to another agent's nickname", async () => {
    const first = await (await createAgent(app, providerId, "Alpha")).json();
    const second = await (await createAgent(app, providerId, "Beta")).json();
    const response = await app.request(`/agents/${second.id}`, {
      method: "PUT",
      body: JSON.stringify({ nickname: ` ${first.nickname.toUpperCase()} ` }),
    });
    expect(response.status).toBe(409);
  });

  it("accepts common raster image data URLs and rejects SVG uploads", async () => {
    const uploaded = await createAgent(app, providerId, "Custom", "data:image/png;base64,iVBORw0KGgo=");
    expect(uploaded.status).toBe(201);
    expect((await uploaded.json()).avatar).toStartWith("data:image/png;base64,");

    const svg = await createAgent(app, providerId, "Unsafe", "data:image/svg+xml;base64,PHN2Zz4=");
    expect(svg.status).toBe(400);
  });

  it("stores only explicitly declared reasoning efforts and rejects unsupported defaults", async () => {
    const valid = await app.request("/agents", {
      method: "POST",
      body: JSON.stringify({ nickname: "Reasoner", avatar: AGENT_AVATARS[0], providerId, modelId: "reasoning-model", reasoningEfforts: ["low", "high"], reasoningEffort: "high" }),
    });
    expect(valid.status).toBe(201);
    expect(await valid.json()).toMatchObject({ reasoningEffort: "high", modelCapabilities: { reasoningEfforts: ["low", "high"] } });
    const unsupported = await app.request("/agents", {
      method: "POST",
      body: JSON.stringify({ nickname: "Invalid", avatar: AGENT_AVATARS[1], providerId, modelId: "reasoning-model", reasoningEfforts: ["low"], reasoningEffort: "high" }),
    });
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toEqual({ error: "reasoning_effort_unsupported" });
  });

  it("persists an explicit model context window capability and rejects unsafe bounds", async () => {
    const valid = await app.request("/agents", {
      method: "POST",
      body: JSON.stringify({
        nickname: "Long Context",
        avatar: AGENT_AVATARS[2],
        providerId,
        modelId: "long-model",
        contextWindowTokens: 128_000,
      }),
    });
    expect(valid.status).toBe(201);
    expect(await valid.json()).toMatchObject({
      modelCapabilities: { contextWindowTokens: 128_000 },
    });
    const invalid = await app.request("/agents", {
      method: "POST",
      body: JSON.stringify({
        nickname: "Too Small",
        avatar: AGENT_AVATARS[3],
        providerId,
        modelId: "tiny-model",
        contextWindowTokens: 512,
      }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "context_window_tokens_invalid" });
  });
});
