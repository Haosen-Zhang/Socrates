import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  buildTestRequest,
  classifyTestOutcome,
  resolveBaseUrl,
  validateProviderInput,
  type Provider,
  type ProviderType,
} from "@socrates/core";
import type { SecretStore } from "./secrets";

type Row = {
  id: string;
  name: string;
  type: ProviderType;
  base_url: string;
  default_model: string | null;
  api_key_ref: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

function toProvider(r: Row): Provider {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    baseUrl: r.base_url,
    defaultModel: r.default_model ?? undefined,
    apiKeyRef: r.api_key_ref,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** 路由只需要「可调用的 fetch」，收窄类型好让测试注入替身 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function providerRoutes(db: Database, secrets: SecretStore, fetchFn: FetchLike = fetch) {
  const app = new Hono();
  const byId = (id: string) => db.query<Row, [string]>("SELECT * FROM providers WHERE id = ?").get(id);

  app.get("/", (c) => {
    const rows = db.query<Row, []>("SELECT * FROM providers ORDER BY created_at").all();
    return c.json(rows.map(toProvider));
  });

  app.post("/", async (c) => {
    const body = await c.req.json<{
      name: string;
      type: ProviderType;
      baseUrl?: string;
      defaultModel?: string;
      apiKey: string;
    }>();
    const invalid = validateProviderInput(body);
    if (invalid) return c.json({ error: invalid }, 400);
    if (!body.apiKey?.trim()) return c.json({ error: "apiKey 不能为空" }, 400);

    const id = crypto.randomUUID();
    const ref = `provider:${id}`;
    const now = new Date().toISOString();
    secrets.set(ref, body.apiKey);
    db.run(
      `INSERT INTO providers (id, name, type, base_url, default_model, api_key_ref, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [id, body.name.trim(), body.type, resolveBaseUrl(body.type, body.baseUrl), body.defaultModel ?? null, ref, now, now],
    );
    return c.json(toProvider(byId(id)!), 201);
  });

  app.put("/:id", async (c) => {
    const row = byId(c.req.param("id"));
    if (!row) return c.json({ error: "provider 不存在" }, 404);
    const body = await c.req.json<{
      name?: string;
      baseUrl?: string;
      defaultModel?: string;
      apiKey?: string;
      enabled?: boolean;
    }>();
    const name = body.name?.trim() || row.name;
    const baseUrl = body.baseUrl !== undefined ? resolveBaseUrl(row.type, body.baseUrl) : row.base_url;
    const defaultModel = body.defaultModel !== undefined ? body.defaultModel || null : row.default_model;
    const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : row.enabled;
    if (body.apiKey?.trim()) secrets.set(row.api_key_ref, body.apiKey);
    db.run(
      "UPDATE providers SET name = ?, base_url = ?, default_model = ?, enabled = ?, updated_at = ? WHERE id = ?",
      [name, baseUrl, defaultModel, enabled, new Date().toISOString(), row.id],
    );
    return c.json(toProvider(byId(row.id)!));
  });

  app.delete("/:id", (c) => {
    const row = byId(c.req.param("id"));
    if (!row) return c.json({ error: "provider 不存在" }, 404);
    db.run("DELETE FROM providers WHERE id = ?", [row.id]);
    secrets.delete(row.api_key_ref);
    return c.json({ ok: true });
  });

  app.post("/:id/test", async (c) => {
    const row = byId(c.req.param("id"));
    if (!row) return c.json({ error: "provider 不存在" }, 404);
    const key = secrets.get(row.api_key_ref);
    if (!key) return c.json({ outcome: "error", detail: "Keychain 中找不到 API Key，请重新填写" });
    const req = buildTestRequest(row.type, row.base_url, key);
    try {
      const res = await fetchFn(req.url, { headers: req.headers, signal: AbortSignal.timeout(10_000) });
      const outcome = classifyTestOutcome(res.status);
      const detail = outcome === "ok" ? undefined : (await res.text()).slice(0, 300);
      return c.json({ outcome, status: res.status, detail });
    } catch (err) {
      return c.json({ outcome: "network_error", detail: String(err).slice(0, 300) });
    }
  });

  return app;
}
