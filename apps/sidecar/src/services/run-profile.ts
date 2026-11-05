import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { UNKNOWN_MODEL_CAPABILITIES, type ModelCapabilities, type ReasoningEffort, type ConversationStoredMessage } from "@socrates/core";

/** Public, credential-free snapshot. The provider key is resolved at dispatch. */
export interface RunProfile {
  agentId: string;
  providerId: string;
  modelId: string;
  nickname: string;
  avatar?: string;
  role: string;
  systemPrompt: string;
  temperature?: number;
  reasoningEffort: ReasoningEffort;
  modelCapabilities: ModelCapabilities;
  contextWindowTokens: number | null;
  configurationVersion: string;
  overrides: { reasoningEffort?: ReasoningEffort };
}

export function resolveRunProfile(
  agentId: string,
  snapshot: Record<string, unknown>,
  overrides: { reasoningEffort?: ReasoningEffort } = {},
): RunProfile {
  const capabilities = structuredClone({ ...UNKNOWN_MODEL_CAPABILITIES,
    ...(snapshot.modelCapabilities && typeof snapshot.modelCapabilities === "object"
      ? snapshot.modelCapabilities as Partial<ModelCapabilities> : {}) });
  const requested = overrides.reasoningEffort ?? snapshot.reasoningEffort ?? "auto";
  if (!["auto", "disabled", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(requested))) throw new Error("reasoning_effort_unavailable");
  const knownEfforts = capabilities.reasoningEfforts;
  if (requested !== "auto" && Array.isArray(knownEfforts) && !knownEfforts.includes(requested as ReasoningEffort)) {
    throw new Error("reasoning_effort_unavailable");
  }
  const window = capabilities.contextWindow?.effectiveValue ?? capabilities.contextWindowTokens ?? snapshot.contextWindowTokens;
  const text = (key: string) => typeof snapshot[key] === "string" ? snapshot[key] as string : "";
  const profile: RunProfile = {
    agentId, providerId: text("providerId"), modelId: text("modelId"), nickname: text("nickname"),
    ...(text("avatar") ? { avatar: text("avatar") } : {}),
    role: text("role"), systemPrompt: text("systemPrompt"),
    ...(typeof snapshot.temperature === "number" && Number.isFinite(snapshot.temperature) ? { temperature: snapshot.temperature } : {}),
    reasoningEffort: requested as ReasoningEffort,
    modelCapabilities: capabilities,
    contextWindowTokens: typeof window === "number" && Number.isFinite(window)
      ? Math.min(4_000_000, Math.max(1_024, Math.floor(window))) : null,
    configurationVersion: text("updatedAt") || text("configurationVersion") || createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
    overrides: { ...overrides },
  };
  return Object.freeze(profile);
}

export function resolveSessionRunProfile(db: Database, sessionId: string, agentId: string,
  overrides: { reasoningEffort?: ReasoningEffort } = {}): RunProfile {
  const row = db.query<{ snapshot_json: string }, [string, string]>(
    "SELECT snapshot_json FROM session_agents WHERE session_id = ? AND agent_id = ?",
  ).get(sessionId, agentId);
  if (!row) throw new Error("agent_must_be_room_member");
  return resolveRunProfile(agentId, JSON.parse(row.snapshot_json), overrides);
}

/** Public statements from peers are data; only this member owns its tool transcript. */
export function memberConversationHistory(history: ConversationStoredMessage[], agentId: string): ConversationStoredMessage[] {
  return history.flatMap((message) => {
    if (message.role === "user") return [message];
    if (message.agentId === agentId && message.role !== "system") return [message];
    if (message.kind === "tool_call" || message.kind === "tool_result" || message.role === "tool") return [];
    const content = `<untrusted_room_message author=${JSON.stringify(message.agentId ?? "room")}>
${message.content}
</untrusted_room_message>`;
    return [{ ...message, role: "user" as const, content, parts: [{ type: "text" as const, text: content }] }];
  });
}
