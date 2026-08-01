import type { ProviderType } from "./provider";

export type CapabilityState = boolean | "unknown";
export type ReasoningEffort = "auto" | "disabled" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ReasoningModelFamily =
  | "openai"
  | "deepseek"
  | "anthropic"
  | "gemini"
  | "qwen"
  | "kimi"
  | "glm"
  | "grok"
  | "llama"
  | "mistral"
  | "custom";

export type ReasoningProfile = {
  family: ReasoningModelFamily;
  efforts: ReasoningEffort[];
  defaultEffort: "auto";
};

const REASONING_EFFORTS = new Set<ReasoningEffort>([
  "auto", "disabled", "minimal", "low", "medium", "high", "xhigh", "max",
]);

const profile = (family: ReasoningModelFamily, efforts: ReasoningEffort[]): ReasoningProfile => ({
  family,
  efforts,
  defaultEffort: "auto",
});

/**
 * Conservative catalog for the effort controls exposed by common hosted model
 * families. `auto` always means "use the provider default"; custom/open-weight
 * deployments get no invented transport control.
 */
export function resolveReasoningProfile(
  providerType: ProviderType,
  modelId: string,
  capabilityOverride?: ReasoningEffort[] | "unknown",
): ReasoningProfile {
  const id = modelId.trim().toLowerCase();

  if (id.includes("deepseek")) return profile("deepseek", ["auto", "disabled", "high", "max"]);
  if (providerType === "anthropic" || id.includes("claude")) {
    if (/(?:opus|sonnet)-(?:5|4[.-](?:7|8))|(?:fable|mythos)-5/.test(id)) {
      return profile("anthropic", ["auto", "low", "medium", "high", "xhigh", "max"]);
    }
    if (/(?:opus|sonnet)-4[.-]6/.test(id)) {
      return profile("anthropic", ["auto", "low", "medium", "high", "max"]);
    }
    if (/opus-4[.-]5/.test(id)) return profile("anthropic", ["auto", "low", "medium", "high"]);
    return profile("anthropic", ["auto", "disabled"]);
  }
  if (/(?:^|[/_-])(?:gpt-5(?:[.-]|$)|o[134](?:-|$))/.test(id)) {
    return profile("openai", ["auto", "disabled", "low", "medium", "high", "xhigh"]);
  }
  if (/(?:^|[/_-])gpt-/.test(id)) return profile("openai", ["auto", "disabled"]);
  if (id.includes("gemini")) {
    if (/gemini-3(?:\.[0-9]+)?-pro/.test(id)) return profile("gemini", ["auto", "minimal", "low", "high"]);
    return profile("gemini", ["auto", "minimal", "low", "medium", "high"]);
  }
  if (id.includes("qwen")) {
    if (/qwen3[.-]8/.test(id)) return profile("qwen", ["auto", "disabled", "low", "medium", "xhigh"]);
    return profile("qwen", ["auto", "disabled"]);
  }
  if (id.includes("kimi") || id.includes("moonshot")) return profile("kimi", ["auto", "disabled"]);
  if (/(?:^|[/_-])glm(?:[-_.]|$)/.test(id)) return profile("glm", ["auto", "disabled", "high", "max"]);
  if (id.includes("grok")) return profile("grok", ["auto", "disabled", "low", "high"]);
  if (id.includes("llama")) return openWeightProfile("llama", capabilityOverride);
  if (id.includes("mistral") || id.includes("magistral")) return openWeightProfile("mistral", capabilityOverride);
  return openWeightProfile("custom", capabilityOverride);
}

function openWeightProfile(
  family: Extract<ReasoningModelFamily, "llama" | "mistral" | "custom">,
  capabilityOverride?: ReasoningEffort[] | "unknown",
): ReasoningProfile {
  if (!Array.isArray(capabilityOverride)) return profile(family, ["auto", "disabled"]);
  const valid = capabilityOverride.filter((effort) => REASONING_EFFORTS.has(effort));
  return profile(family, [...new Set<ReasoningEffort>(["auto", ...valid])]);
}

export interface ModelCapabilities {
  textInput: CapabilityState;
  imageInput: CapabilityState;
  fileInput: CapabilityState;
  toolCalling: CapabilityState;
  streaming: CapabilityState;
  reasoningEfforts: ReasoningEffort[] | "unknown";
  runtimeKinds: ("native" | "langgraph_socrates")[] | "unknown";
  /** Provider/model context limit when known; unknown uses a conservative runtime fallback. */
  contextWindowTokens?: number | "unknown";
}

export const UNKNOWN_MODEL_CAPABILITIES: Readonly<ModelCapabilities> = Object.freeze({
  textInput: "unknown",
  imageInput: "unknown",
  fileInput: "unknown",
  toolCalling: "unknown",
  streaming: "unknown",
  reasoningEfforts: "unknown",
  runtimeKinds: "unknown",
  contextWindowTokens: "unknown",
});

export function mergeModelCapabilities(
  catalog: ModelCapabilities,
  override: Partial<ModelCapabilities>,
): ModelCapabilities {
  return { ...catalog, ...override };
}

export function supportsRequest(
  capabilities: ModelCapabilities,
  required: Partial<Record<keyof ModelCapabilities, boolean>>,
): { ok: boolean; missing: (keyof ModelCapabilities)[] } {
  const missing = (Object.keys(required) as (keyof ModelCapabilities)[]).filter(
    (key) => required[key] && capabilities[key] !== true,
  );
  return { ok: missing.length === 0, missing };
}

export type ProviderErrorKind = "auth" | "rate_limit" | "network" | "capability" | "invalid_request" | "provider";

export interface ProviderErrorDetail {
  kind: ProviderErrorKind;
  message: string;
  retryable: boolean;
  statusCode?: number;
  providerCode?: string;
}
