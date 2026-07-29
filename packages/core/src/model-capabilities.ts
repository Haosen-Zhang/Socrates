export type CapabilityState = boolean | "unknown";
export type ReasoningEffort = "auto" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
