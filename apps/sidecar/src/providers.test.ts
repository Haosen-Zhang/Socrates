import { describe, expect, it, beforeEach } from "bun:test";
import { Hono } from "hono";
import { openDb } from "./db";
import { MemorySecrets } from "./secrets";
import { providerRoutes, type FetchLike } from "./providers";

const SECRET = "sk-test-secret-abc";

function makeApp(fetchFn?: FetchLike) {
  const db = openDb(":memory:");
  const secrets = new MemorySecrets();
  const app = new Hono().route("/providers", providerRoutes(db, secrets, fetchFn));
  return { app, secrets };
}

async function createProvider(app: Hono, overrides: Record<string, unknown> = {}) {
  const res = await app.request("/providers", {
    method: "POST",
    body: JSON.stringify({
      name: "DeepSeek",
      type: "openai_compatible",
      baseUrl: "https://api.deepseek.com",
      defaultModel: "deepseek-v4-flash",
      apiKey: SECRET,
      ...overrides,
    }),
  });
  return res;
}

describe("provider CRUD", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(() => {
    ctx = makeApp();
  });

  it("creates and lists without ever exposing the key", async () => {
    const created = await createProvider(ctx.app);
    expect(created.status).toBe(201);
    const provider = await created.json();
    expect(provider.apiKeyRef).toStartWith("provider:");
    expect(JSON.stringify(provider)).not.toContain(SECRET);

    const list = await ctx.app.request("/providers");
    const body = await list.text();
    expect(body).toContain("DeepSeek");
    expect(body).not.toContain(SECRET);
    expect(ctx.secrets.get(provider.apiKeyRef)).toBe(SECRET);
  });

  it("rejects invalid input", async () => {
    expect((await createProvider(ctx.app, { name: " " })).status).toBe(400);
    expect((await createProvider(ctx.app, { apiKey: "" })).status).toBe(400);
    expect((await createProvider(ctx.app, { type: "nope" })).status).toBe(400);
  });

  it("updates fields and rotates the key", async () => {
    const p = await (await createProvider(ctx.app)).json();
    const res = await ctx.app.request(`/providers/${p.id}`, {
      method: "PUT",
      body: JSON.stringify({ name: "DS", apiKey: "sk-new" }),
    });
    const updated = await res.json();
    expect(updated.name).toBe("DS");
    expect(ctx.secrets.get(p.apiKeyRef)).toBe("sk-new");
  });

  it("updates provider type and resolves its new default base URL", async () => {
    const p = await (await createProvider(ctx.app, { baseUrl: "" })).json();
    const res = await ctx.app.request(`/providers/${p.id}`, {
      method: "PUT",
      body: JSON.stringify({ type: "anthropic", baseUrl: "" }),
    });
    const updated = await res.json();
    expect(updated.type).toBe("anthropic");
    expect(updated.baseUrl).toBe("https://api.anthropic.com");
  });

  it("deletes row and keychain entry together", async () => {
    const p = await (await createProvider(ctx.app)).json();
    await ctx.app.request(`/providers/${p.id}`, { method: "DELETE" });
    expect(ctx.secrets.get(p.apiKeyRef)).toBeNull();
    const list = await (await ctx.app.request("/providers")).json();
    expect(list).toHaveLength(0);
    expect((await ctx.app.request(`/providers/${p.id}`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("model list", () => {
  it("returns sorted model ids from the provider", async () => {
    const fetchFn: FetchLike = async () =>
      new Response(JSON.stringify({ data: [{ id: "gpt-5.5" }, { id: "gpt-5.4" }, { name: "named-only" }] }), {
        status: 200,
      });
    const { app } = makeApp(fetchFn);
    const p = await (await createProvider(app)).json();
    const res = await app.request(`/providers/${p.id}/models`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(["gpt-5.4", "gpt-5.5", "named-only"]);
  });

  it("maps provider failure to 502 with readable error", async () => {
    const fetchFn: FetchLike = async () => new Response("nope", { status: 401 });
    const { app } = makeApp(fetchFn);
    const p = await (await createProvider(app)).json();
    const res = await app.request(`/providers/${p.id}/models`);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("401");
  });

  it("discovers models for an unsaved provider without persisting its key", async () => {
    const seen: Array<{ url: string; authorization?: string }> = [];
    const fetchFn: FetchLike = async (url, init) => {
      seen.push({ url, authorization: (init?.headers as Record<string, string>).Authorization });
      return new Response(JSON.stringify({ data: [{ id: "gpt-5.4" }, { id: "gpt-5-nano" }] }), { status: 200 });
    };
    const { app, secrets } = makeApp(fetchFn);
    let secretWrites = 0;
    const originalSet = secrets.set.bind(secrets);
    secrets.set = (ref, secret) => {
      secretWrites += 1;
      originalSet(ref, secret);
    };
    const res = await app.request("/providers/models/discover", {
      method: "POST",
      body: JSON.stringify({
        type: "openai_compatible",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-preview-only",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(["gpt-5-nano", "gpt-5.4"]);
    expect(seen).toEqual([
      { url: "https://api.openai.com/v1/models", authorization: "Bearer sk-preview-only" },
    ]);
    expect(secretWrites).toBe(0);
  });

  it("discovers models for an existing provider with its Keychain key", async () => {
    const seenAuth: string[] = [];
    const fetchFn: FetchLike = async (_url, init) => {
      seenAuth.push((init?.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify({ data: [{ id: "deepseek-chat" }] }), { status: 200 });
    };
    const { app } = makeApp(fetchFn);
    const provider = await (await createProvider(app)).json();
    const res = await app.request("/providers/models/discover", {
      method: "POST",
      body: JSON.stringify({
        providerId: provider.id,
        type: provider.type,
        baseUrl: provider.baseUrl,
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(["deepseek-chat"]);
    expect(seenAuth).toEqual([`Bearer ${SECRET}`]);
  });
});

describe("connection test", () => {
  const cases: Array<[string, FetchLike, string]> = [
    ["200 → ok", async () => new Response("{}", { status: 200 }), "ok"],
    ["401 → auth_failed", async () => new Response("bad key", { status: 401 }), "auth_failed"],
    ["fetch throws → network_error", async () => { throw new Error("ECONNREFUSED"); }, "network_error"],
  ];

  for (const [label, fetchFn, expected] of cases) {
    it(label, async () => {
      const { app } = makeApp(fetchFn);
      const p = await (await createProvider(app)).json();
      const res = await app.request(`/providers/${p.id}/test`, { method: "POST" });
      const body = await res.json();
      expect(body.outcome).toBe(expected);
    });
  }

  it("uses the stored key in the outgoing request", async () => {
    const seen: string[] = [];
    const spy: FetchLike = async (_url, init) => {
      seen.push((init?.headers as Record<string, string>).Authorization);
      return new Response("{}", { status: 200 });
    };
    const { app } = makeApp(spy);
    const p = await (await createProvider(app)).json();
    await app.request(`/providers/${p.id}/test`, { method: "POST" });
    expect(seen).toEqual([`Bearer ${SECRET}`]);
  });
});
