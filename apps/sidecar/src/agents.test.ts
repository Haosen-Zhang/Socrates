import { beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { AGENT_AVATARS } from "@socrates/core";
import { openDb } from "./db";
import { MemorySecrets } from "./secrets";
import { providerRoutes } from "./providers";
import { agentRoutes } from "./agents";

function makeApp(db = openDb(":memory:")) {
  const app = new Hono();
  app.route("/providers", providerRoutes(db, new MemorySecrets()));
  app.route("/agents", agentRoutes(db));
  return app;
}

async function createProvider(app: Hono, type: "openai_compatible" | "anthropic" = "openai_compatible"): Promise<string> {
  const response = await app.request("/providers", {
    method: "POST",
    body: JSON.stringify({ name: type === "anthropic" ? "Anthropic" : "OpenAI", type, apiKey: "sk-test" }),
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
  let db: ReturnType<typeof openDb>;
  let providerId: string;

  beforeEach(async () => {
    db = openDb(":memory:");
    app = makeApp(db);
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

  it("derives model-aware reasoning efforts and rejects unsupported selections", async () => {
    const valid = await app.request("/agents", {
      method: "POST",
      body: JSON.stringify({ nickname: "Reasoner", avatar: AGENT_AVATARS[0], providerId, modelId: "gpt-5.4", reasoningEffort: "high" }),
    });
    expect(valid.status).toBe(201);
    expect(await valid.json()).toMatchObject({
      reasoningEffort: "high",
      modelCapabilities: { reasoningEfforts: ["auto", "disabled", "low", "medium", "high", "xhigh"] },
    });
    const unsupported = await app.request("/agents", {
      method: "POST",
      body: JSON.stringify({ nickname: "Invalid", avatar: AGENT_AVATARS[1], providerId, modelId: "gpt-5.4", reasoningEffort: "max" }),
    });
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toEqual({ error: "reasoning_effort_unsupported" });

    const nonReasoning = await app.request("/agents", {
      method: "POST",
      body: JSON.stringify({ nickname: "GPT 4o", avatar: AGENT_AVATARS[2], providerId, modelId: "gpt-4o", reasoningEffort: "xhigh" }),
    });
    expect(nonReasoning.status).toBe(400);
  });

  it("supports DeepSeek and Anthropic profiles without manual capability checkboxes", async () => {
    const deepseek = await app.request("/agents", {
      method: "POST",
      body: JSON.stringify({ nickname: "Deep", providerId, modelId: "deepseek-v4-pro", reasoningEffort: "max" }),
    });
    expect(deepseek.status).toBe(201);
    expect(await deepseek.json()).toMatchObject({
      reasoningEffort: "max",
      modelCapabilities: { reasoningEfforts: ["auto", "disabled", "high", "max"] },
    });

    const anthropicProviderId = await createProvider(app, "anthropic");
    const claude = await app.request("/agents", {
      method: "POST",
      body: JSON.stringify({ nickname: "Claude", providerId: anthropicProviderId, modelId: "claude-opus-4-8", reasoningEffort: "xhigh" }),
    });
    expect(claude.status).toBe(201);
    expect(await claude.json()).toMatchObject({ reasoningEffort: "xhigh" });
  });

  it("normalizes a missing legacy selection to required auto", async () => {
    const response = await createAgent(app, providerId, "Legacy Client");
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      reasoningEffort: "auto",
      modelCapabilities: { reasoningEfforts: ["auto", "disabled"] },
    });
  });

  it("preserves supported effort on unrelated or same-model updates and resets only real changes", async () => {
    const created = await app.request("/agents", {
      method: "POST",
      body: JSON.stringify({ nickname: "Stable", providerId, modelId: "gpt-5.4", reasoningEffort: "high" }),
    });
    const agent = await created.json();

    const unrelated = await app.request(`/agents/${agent.id}`, {
      method: "PUT",
      body: JSON.stringify({ role: "reviewer" }),
    });
    expect(await unrelated.json()).toMatchObject({ reasoningEffort: "high" });

    const sameModel = await app.request(`/agents/${agent.id}`, {
      method: "PUT",
      body: JSON.stringify({ providerId, modelId: "gpt-5.4" }),
    });
    expect(await sameModel.json()).toMatchObject({ reasoningEffort: "high" });

    const changedModel = await app.request(`/agents/${agent.id}`, {
      method: "PUT",
      body: JSON.stringify({ modelId: "deepseek-v4-pro" }),
    });
    expect(await changedModel.json()).toMatchObject({
      reasoningEffort: "auto",
      modelCapabilities: { reasoningEfforts: ["auto", "disabled", "high", "max"] },
    });
  });

  it("normalizes a stored legacy unsupported effort during an unrelated update", async () => {
    const created = await app.request("/agents", {
      method: "POST",
      body: JSON.stringify({ nickname: "Legacy Invalid", providerId, modelId: "gpt-5.4", reasoningEffort: "high" }),
    });
    const agent = await created.json();
    db.run(
      "UPDATE agents SET model_id = ?, reasoning_effort = ?, model_capabilities_json = ? WHERE id = ?",
      ["company-model", "max", JSON.stringify({ reasoningEfforts: ["auto", "low", "high"] }), agent.id],
    );

    const unrelated = await app.request(`/agents/${agent.id}`, {
      method: "PUT",
      body: JSON.stringify({ role: "legacy" }),
    });
    expect(await unrelated.json()).toMatchObject({
      reasoningEffort: "auto",
      modelCapabilities: { reasoningEfforts: ["auto", "low", "high"] },
    });
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
