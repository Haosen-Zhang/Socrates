import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  agentIdentityFromSeed,
  isAgentAvatarSource,
  normalizeAgentNickname,
  randomAgentIdentity,
  UNKNOWN_MODEL_CAPABILITIES,
  type ModelCapabilities,
  type ReasoningEffort,
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
  reasoning_effort: string | null;
  model_capabilities_json: string | null;
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
    modelCapabilities: r.model_capabilities_json ? JSON.parse(r.model_capabilities_json) : { ...UNKNOWN_MODEL_CAPABILITIES },
    reasoningEffort: r.reasoning_effort ? r.reasoning_effort as ReasoningEffort : undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function agentRoutes(db: Database) {
  const app = new Hono();
  const byId = (id: string) => db.query<AgentRow, [string]>("SELECT * FROM agents WHERE id = ?").get(id);
  const providerById = (id: string) =>
    db.query<{ id: string; type: string }, [string]>("SELECT id, type FROM providers WHERE id = ?").get(id);
  const nicknameTaken = (nickname: string, excludingId?: string) => {
    const key = normalizeAgentNickname(nickname);
    return db
      .query<Pick<AgentRow, "id" | "display_name" | "nickname">, []>(
        "SELECT id, display_name, nickname FROM agents",
      )
      .all()
      .some((agent) => agent.id !== excludingId && normalizeAgentNickname(agent.nickname ?? agent.display_name) === key);
  };

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
      reasoningEfforts?: ReasoningEffort[];
      reasoningEffort?: ReasoningEffort;
    }>();
    if (!b.nickname?.trim()) return c.json({ error: "昵称不能为空" }, 400);
    if (!b.modelId?.trim()) return c.json({ error: "模型不能为空" }, 400);
    const provider = providerById(b.providerId);
    if (!provider) return c.json({ error: "供应商不存在" }, 400);
    const reasoning = validateReasoning(b.reasoningEfforts, b.reasoningEffort);
    if (reasoning.error) return c.json({ error: reasoning.error }, 400);
    if (reasoning.efforts !== "unknown" && reasoning.efforts.length > 0 && provider.type !== "openai_compatible") return c.json({ error: "reasoning_effort_adapter_unsupported" }, 400);
    const nickname = b.nickname.trim();
    if (nicknameTaken(nickname)) return c.json({ error: "昵称已被使用" }, 409);
    if (b.avatar !== undefined && !isAgentAvatarSource(b.avatar)) return c.json({ error: "头像格式不受支持或文件过大" }, 400);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const identity = randomAgentIdentity();
    db.run(
      `INSERT INTO agents (id, display_name, nickname, avatar, provider_id, model_id, role, system_prompt, temperature, reasoning_effort, model_capabilities_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        reasoning.effort,
        JSON.stringify({ ...UNKNOWN_MODEL_CAPABILITIES, reasoningEfforts: reasoning.efforts }),
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
      reasoningEfforts: ReasoningEffort[];
      reasoningEffort: ReasoningEffort | null;
    }>>();
    if (b.providerId !== undefined && !providerById(b.providerId)) {
      return c.json({ error: "供应商不存在" }, 400);
    }
    if (b.avatar !== undefined && !isAgentAvatarSource(b.avatar)) return c.json({ error: "头像格式不受支持或文件过大" }, 400);
    const currentCapabilities = row.model_capabilities_json ? JSON.parse(row.model_capabilities_json) as ModelCapabilities : UNKNOWN_MODEL_CAPABILITIES;
    const reasoning = validateReasoning(b.reasoningEfforts ?? (currentCapabilities.reasoningEfforts === "unknown" ? undefined : currentCapabilities.reasoningEfforts), b.reasoningEffort === undefined ? row.reasoning_effort as ReasoningEffort | undefined : b.reasoningEffort ?? undefined);
    if (reasoning.error) return c.json({ error: reasoning.error }, 400);
    const nextProvider = providerById(b.providerId ?? row.provider_id);
    if (reasoning.efforts !== "unknown" && reasoning.efforts.length > 0 && nextProvider?.type !== "openai_compatible") return c.json({ error: "reasoning_effort_adapter_unsupported" }, 400);
    const nickname = b.nickname?.trim() || row.nickname || agentIdentityFromSeed(row.id).nickname;
    if (nicknameTaken(nickname, row.id)) return c.json({ error: "昵称已被使用" }, 409);
    db.run(
      `UPDATE agents SET display_name = ?, nickname = ?, avatar = ?, provider_id = ?, model_id = ?, role = ?, system_prompt = ?, temperature = ?, reasoning_effort = ?, model_capabilities_json = ?, updated_at = ?
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
        reasoning.effort,
        JSON.stringify({ ...currentCapabilities, reasoningEfforts: reasoning.efforts }),
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

const REASONING_EFFORTS = new Set<ReasoningEffort>(["auto", "minimal", "low", "medium", "high", "xhigh", "max"]);
function validateReasoning(efforts: ReasoningEffort[] | undefined, effort: ReasoningEffort | undefined): { efforts: ReasoningEffort[] | "unknown"; effort: ReasoningEffort | null; error?: string } {
  if (efforts === undefined) return effort ? { efforts: "unknown", effort: null, error: "reasoning_effort_capability_unknown" } : { efforts: "unknown", effort: null };
  if (!Array.isArray(efforts) || efforts.some((item) => !REASONING_EFFORTS.has(item)) || new Set(efforts).size !== efforts.length) return { efforts: "unknown", effort: null, error: "reasoning_efforts_invalid" };
  if (effort && !efforts.includes(effort)) return { efforts, effort: null, error: "reasoning_effort_unsupported" };
  return { efforts, effort: effort ?? null };
}
