import type { ReasoningEffort } from "./model-capabilities";

export interface NormalizedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  cost: number | null;
  currency: string | null;
  source: "provider" | "estimated" | "unavailable";
  estimated: boolean;
  effort: ReasoningEffort | null;
}

export const UNAVAILABLE_USAGE: Readonly<NormalizedUsage> = Object.freeze({
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  cachedInputTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
  cost: null,
  currency: null,
  source: "unavailable",
  estimated: false,
  effort: null,
});
