import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  agentIdentityFromSeed,
  isAgentAvatarSource,
  normalizeAgentNickname,
  randomAgentIdentity,
  resolveReasoningProfile,
  resolveContextWindow,
  UNKNOWN_MODEL_CAPABILITIES,
  type ModelCapabilities,
  type ProviderType,
  type ReasoningEffort,
  type Agent,
  type ContextWindowResolution,
} from "@socrates/core";
import type { ModelCatalog } from "./model-catalog";

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
  const modelCapabilities = r.model_capabilities_json ? JSON.parse(r.model_capabilities_json) as ModelCapabilities : { ...UNKNOWN_MODEL_CAPABILITIES };
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
    modelCapabilities,
    contextWindow: modelCapabilities.contextWindow,
    reasoningEffort: r.reasoning_effort ? r.reasoning_effort as ReasoningEffort : "auto",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function agentRoutes(db: Database, modelCatalog?: ModelCatalog) {
  const app = new Hono();
  const byId = (id: string) => db.query<AgentRow, [string]>("SELECT * FROM agents WHERE id = ?").get(id);
  const providerById = (id: string) =>
    db.query<{ id: string; type: string; base_url: string; catalog_provider_id: string | null }, [string]>("SELECT id, type, base_url, catalog_provider_id FROM providers WHERE id = ?").get(id);
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

  app.get("/context-window", async (c) => {
    const provider = providerById(c.req.query("providerId") ?? "");
    const modelId = c.req.query("modelId")?.trim() ?? "";
    if (!provider) return c.json({ error: "供应商不存在" }, 404);
    if (!modelId) return c.json({ error: "模型不能为空" }, 400);
    return c.json(await resolveCatalogWindow(modelCatalog, provider, modelId, null));
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
      reasoningEffort?: ReasoningEffort;
      userOverride?: number | null;
    }>();
    if (!b.nickname?.trim()) return c.json({ error: "昵称不能为空" }, 400);
    if (!b.modelId?.trim()) return c.json({ error: "模型不能为空" }, 400);
    const provider = providerById(b.providerId);
    if (!provider) return c.json({ error: "供应商不存在" }, 400);
    const reasoning = validateReasoning(provider.type as ProviderType, b.modelId, b.reasoningEffort);
    if (reasoning.error) return c.json({ error: reasoning.error }, 400);
    const userOverride = validateContextWindow(b.userOverride);
    if (userOverride.error) return c.json({ error: userOverride.error }, 400);
    const contextWindow = await resolveCatalogWindow(modelCatalog, provider, b.modelId.trim(), userOverride.value);
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
        JSON.stringify({
          ...UNKNOWN_MODEL_CAPABILITIES,
          reasoningEfforts: reasoning.efforts,
          contextWindowTokens: contextWindow.effectiveValue ?? "unknown",
          contextWindow,
        }),
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
      reasoningEffort: ReasoningEffort | null;
      userOverride: number | null;
    }>>();
    if (b.providerId !== undefined && !providerById(b.providerId)) {
      return c.json({ error: "供应商不存在" }, 400);
    }
    if (b.avatar !== undefined && !isAgentAvatarSource(b.avatar)) return c.json({ error: "头像格式不受支持或文件过大" }, 400);
    const currentCapabilities = row.model_capabilities_json ? JSON.parse(row.model_capabilities_json) as ModelCapabilities : UNKNOWN_MODEL_CAPABILITIES;
    const nextProvider = providerById(b.providerId ?? row.provider_id);
    if (!nextProvider) return c.json({ error: "供应商不存在" }, 400);
    const nextModelId = b.modelId?.trim() || row.model_id;
    const providerChanged = b.providerId !== undefined && b.providerId !== row.provider_id;
    const modelChanged = b.modelId !== undefined && nextModelId !== row.model_id;
    const capabilityOverride = !providerChanged && !modelChanged
      ? currentCapabilities.reasoningEfforts
      : undefined;
    const profile = resolveReasoningProfile(
      nextProvider.type as ProviderType,
      nextModelId,
      capabilityOverride,
    );
    const storedEffort = (row.reasoning_effort as ReasoningEffort | null) ?? "auto";
    const requestedEffort = b.reasoningEffort === undefined
      ? (providerChanged || modelChanged || !profile.efforts.includes(storedEffort)
        ? "auto"
        : storedEffort)
      : b.reasoningEffort ?? "auto";
    const reasoning = validateReasoning(
      nextProvider.type as ProviderType,
      nextModelId,
      requestedEffort,
      capabilityOverride,
    );
    if (reasoning.error) return c.json({ error: reasoning.error }, 400);
    const existingResolution = currentCapabilities.contextWindow as ContextWindowResolution | undefined;
    const requestedOverride = b.userOverride === undefined
      ? existingResolution?.userOverride ?? (typeof currentCapabilities.contextWindowTokens === "number" ? currentCapabilities.contextWindowTokens : null)
      : b.userOverride;
    const userOverride = validateContextWindow(requestedOverride);
    if (userOverride.error) return c.json({ error: userOverride.error }, 400);
    const contextWindow = providerChanged || modelChanged || b.userOverride !== undefined
      ? await resolveCatalogWindow(modelCatalog, nextProvider, nextModelId, userOverride.value)
      : existingResolution ?? await resolveCatalogWindow(modelCatalog, nextProvider, nextModelId, userOverride.value);
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
        nextModelId,
        b.role ?? row.role,
        b.systemPrompt ?? row.system_prompt,
        b.temperature === undefined ? row.temperature : b.temperature,
        reasoning.effort,
        JSON.stringify({
          ...currentCapabilities,
          reasoningEfforts: reasoning.efforts,
          contextWindowTokens: contextWindow.effectiveValue ?? "unknown",
          contextWindow,
        }),
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

function validateReasoning(
  providerType: ProviderType,
  modelId: string,
  effort: ReasoningEffort | undefined,
  capabilityOverride?: ReasoningEffort[] | "unknown",
): { efforts: ReasoningEffort[]; effort: ReasoningEffort; error?: string } {
  const profile = resolveReasoningProfile(providerType, modelId, capabilityOverride);
  const selected = effort ?? profile.defaultEffort;
  if (!profile.efforts.includes(selected)) {
    return { efforts: profile.efforts, effort: profile.defaultEffort, error: "reasoning_effort_unsupported" };
  }
  return { efforts: profile.efforts, effort: selected };
}

function validateContextWindow(value: number | null | undefined): {
  value: number | null;
  error?: string;
} {
  if (value === undefined || value === null) return { value: null };
  if (!Number.isSafeInteger(value) || value < 1_024 || value > 4_000_000) {
    return { value: null, error: "context_window_tokens_invalid" };
  }
  return { value };
}

async function resolveCatalogWindow(
  catalog: ModelCatalog | undefined,
  provider: { base_url: string; catalog_provider_id: string | null },
  modelId: string,
  userOverride: number | null,
): Promise<ContextWindowResolution> {
  if (catalog) return catalog.resolve({ baseUrl: provider.base_url, catalogProviderId: provider.catalog_provider_id }, modelId, userOverride);
  return resolveContextWindow(null, userOverride, {
    catalogProviderId: null, catalogRevision: null, resolvedAt: new Date().toISOString(),
  });
}
