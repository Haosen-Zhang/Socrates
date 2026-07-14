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

async function listModels(type: ProviderType, baseUrl: string, apiKey: string, fetchFn: FetchLike) {
  const req = buildTestRequest(type, baseUrl, apiKey);
  try {
    const res = await fetchFn(req.url, { headers: req.headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { error: `供应商返回 ${res.status}`, status: 502 as const };
    const body = (await res.json()) as { data?: Array<{ id?: string; name?: string }> };
    const models = (body.data ?? [])
      .map((model) => model.id ?? model.name)
      .filter((model): model is string => typeof model === "string" && model.length > 0)
      .sort();
    return { models };
  } catch (err) {
    return { error: String(err).slice(0, 200), status: 502 as const };
  }
}

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
      type?: ProviderType;
      baseUrl?: string;
      defaultModel?: string;
      apiKey?: string;
      enabled?: boolean;
    }>();
    const name = body.name?.trim() || row.name;
    const type = body.type ?? row.type;
    const baseUrlInput = body.baseUrl !== undefined ? body.baseUrl : type === row.type ? row.base_url : undefined;
    const invalid = validateProviderInput({ name, type, baseUrl: baseUrlInput });
    if (invalid) return c.json({ error: invalid }, 400);
    const baseUrl = resolveBaseUrl(type, baseUrlInput);
    const defaultModel = body.defaultModel !== undefined ? body.defaultModel || null : row.default_model;
    const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : row.enabled;
    if (body.apiKey?.trim()) secrets.set(row.api_key_ref, body.apiKey);
    db.run(
      "UPDATE providers SET name = ?, type = ?, base_url = ?, default_model = ?, enabled = ?, updated_at = ? WHERE id = ?",
      [name, type, baseUrl, defaultModel, enabled, new Date().toISOString(), row.id],
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

  // 新建/编辑弹窗预览模型：新建时用表单 key，编辑时 key 留空可回退 Keychain。
  app.post("/models/discover", async (c) => {
    const body = await c.req.json<{
      providerId?: string;
      type?: ProviderType;
      baseUrl?: string;
      apiKey?: string;
    }>();
    const row = body.providerId ? byId(body.providerId) : undefined;
    if (body.providerId && !row) return c.json({ error: "provider 不存在" }, 404);

    const type = body.type ?? row?.type;
    if (!type) return c.json({ error: "provider 类型不能为空" }, 400);
    const baseUrlInput = body.baseUrl !== undefined ? body.baseUrl : row?.base_url;
    const invalid = validateProviderInput({ name: "preview", type, baseUrl: baseUrlInput });
    if (invalid) return c.json({ error: invalid }, 400);
    const baseUrl = resolveBaseUrl(type, baseUrlInput);
    const key = body.apiKey?.trim() || (row ? secrets.get(row.api_key_ref) : null);
    if (!key) return c.json({ error: "请先填写 API Key" }, 400);

    const result = await listModels(type, baseUrl, key, fetchFn);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.models);
  });

  // 列出该供应商的可用模型型号（OpenAI-compatible 与 Anthropic 的列模型端点都返回 {data:[{id}]}）
  app.get("/:id/models", async (c) => {
    const row = byId(c.req.param("id"));
    if (!row) return c.json({ error: "provider 不存在" }, 404);
    const key = secrets.get(row.api_key_ref);
    if (!key) return c.json({ error: "Keychain 中找不到 API Key" }, 400);
    const result = await listModels(row.type, row.base_url, key, fetchFn);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.models);
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
