import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  AGENT_AVATARS,
  agentIdentityFromSeed,
  randomAgentIdentity,
  type Agent,
} from "@socrates/core";

export type AgentRow = {
  id: string;
  display_name: string;
  nickname: string | null;
  avatar: string | null;
  provider_id: string;
  model_id: string;
  role: string;
  system_prompt: string;
  temperature: number | null;
  created_at: string;
  updated_at: string;
};

export function toAgent(r: AgentRow): Agent {
  const fallback = agentIdentityFromSeed(r.id);
  return {
    id: r.id,
    // display_name 列保留（NOT NULL / 老数据），但 nickname 是唯一对外名称
    nickname: r.nickname ?? r.display_name ?? fallback.nickname,
    avatar: r.avatar ?? fallback.avatar,
    providerId: r.provider_id,
    modelId: r.model_id,
    role: r.role,
    systemPrompt: r.system_prompt,
    temperature: r.temperature ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function agentRoutes(db: Database) {
  const app = new Hono();
  const byId = (id: string) => db.query<AgentRow, [string]>("SELECT * FROM agents WHERE id = ?").get(id);
  const providerExists = (id: string) =>
    db.query<{ id: string }, [string]>("SELECT id FROM providers WHERE id = ?").get(id) !== null;

  app.get("/", (c) => {
    const rows = db.query<AgentRow, []>("SELECT * FROM agents ORDER BY created_at").all();
    return c.json(rows.map(toAgent));
  });

  app.post("/", async (c) => {
    const b = await c.req.json<{
      nickname?: string;
      avatar?: string;
      providerId: string;
      modelId: string;
      role?: string;
      systemPrompt?: string;
      temperature?: number;
    }>();
    if (!b.nickname?.trim()) return c.json({ error: "昵称不能为空" }, 400);
    if (!b.modelId?.trim()) return c.json({ error: "模型不能为空" }, 400);
    if (!providerExists(b.providerId)) return c.json({ error: "供应商不存在" }, 400);
    if (b.avatar !== undefined && !AGENT_AVATARS.includes(b.avatar as (typeof AGENT_AVATARS)[number])) {
      return c.json({ error: "头像不存在" }, 400);
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const identity = randomAgentIdentity();
    const nickname = b.nickname.trim();
    db.run(
      `INSERT INTO agents (id, display_name, nickname, avatar, provider_id, model_id, role, system_prompt, temperature, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        nickname, // display_name 列沿用 nickname（NOT NULL 约束）
        nickname,
        b.avatar ?? identity.avatar,
        b.providerId,
        b.modelId.trim(),
        b.role ?? "",
        b.systemPrompt ?? "",
        b.temperature ?? null,
        now,
        now,
      ],
    );
    return c.json(toAgent(byId(id)!), 201);
  });

  app.put("/:id", async (c) => {
    const row = byId(c.req.param("id"));
    if (!row) return c.json({ error: "agent 不存在" }, 404);
    const b = await c.req.json<Partial<{
      nickname: string;
      avatar: string;
      providerId: string;
      modelId: string;
      role: string;
      systemPrompt: string;
      temperature: number | null;
    }>>();
    if (b.providerId !== undefined && !providerExists(b.providerId)) {
      return c.json({ error: "供应商不存在" }, 400);
    }
    if (b.avatar !== undefined && !AGENT_AVATARS.includes(b.avatar as (typeof AGENT_AVATARS)[number])) {
      return c.json({ error: "头像不存在" }, 400);
    }
    const nickname = b.nickname?.trim() || row.nickname || agentIdentityFromSeed(row.id).nickname;
    db.run(
      `UPDATE agents SET display_name = ?, nickname = ?, avatar = ?, provider_id = ?, model_id = ?, role = ?, system_prompt = ?, temperature = ?, updated_at = ?
       WHERE id = ?`,
      [
        nickname,
        nickname,
        b.avatar ?? row.avatar ?? agentIdentityFromSeed(row.id).avatar,
        b.providerId ?? row.provider_id,
        b.modelId?.trim() || row.model_id,
        b.role ?? row.role,
        b.systemPrompt ?? row.system_prompt,
        b.temperature === undefined ? row.temperature : b.temperature,
        new Date().toISOString(),
        row.id,
      ],
    );
    return c.json(toAgent(byId(row.id)!));
  });

  app.delete("/:id", (c) => {
    const row = byId(c.req.param("id"));
    if (!row) return c.json({ error: "agent 不存在" }, 404);
    db.run("DELETE FROM agents WHERE id = ?", [row.id]);
    db.run("DELETE FROM room_agents WHERE agent_id = ?", [row.id]);
    return c.json({ ok: true });
  });

  return app;
}
