import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { Agent } from "@socrates/core";

export type AgentRow = {
  id: string;
  display_name: string;
  provider_id: string;
  model_id: string;
  role: string;
  system_prompt: string;
  temperature: number | null;
  created_at: string;
  updated_at: string;
};

export function toAgent(r: AgentRow): Agent {
  return {
    id: r.id,
    displayName: r.display_name,
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
      displayName: string;
      providerId: string;
      modelId: string;
      role?: string;
      systemPrompt?: string;
      temperature?: number;
    }>();
    if (!b.displayName?.trim()) return c.json({ error: "名称不能为空" }, 400);
    if (!b.modelId?.trim()) return c.json({ error: "模型不能为空" }, 400);
    if (!providerExists(b.providerId)) return c.json({ error: "供应商不存在" }, 400);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO agents (id, display_name, provider_id, model_id, role, system_prompt, temperature, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, b.displayName.trim(), b.providerId, b.modelId.trim(), b.role ?? "", b.systemPrompt ?? "", b.temperature ?? null, now, now],
    );
    return c.json(toAgent(byId(id)!), 201);
  });

  app.put("/:id", async (c) => {
    const row = byId(c.req.param("id"));
    if (!row) return c.json({ error: "agent 不存在" }, 404);
    const b = await c.req.json<Partial<{
      displayName: string;
      providerId: string;
      modelId: string;
      role: string;
      systemPrompt: string;
      temperature: number | null;
    }>>();
    if (b.providerId !== undefined && !providerExists(b.providerId)) {
      return c.json({ error: "供应商不存在" }, 400);
    }
    db.run(
      `UPDATE agents SET display_name = ?, provider_id = ?, model_id = ?, role = ?, system_prompt = ?, temperature = ?, updated_at = ?
       WHERE id = ?`,
      [
        b.displayName?.trim() || row.display_name,
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
