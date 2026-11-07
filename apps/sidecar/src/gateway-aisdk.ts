import { streamText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { resolveReasoningProfile, type ModelGateway, type ReasoningEffort, type ProviderType, type TokenUsage } from "@socrates/core";
import type { FetchLike } from "./net";
import { classifyProviderError } from "./provider-errors";

type StreamProviderOptions = NonNullable<Parameters<typeof streamText>[0]["providerOptions"]>;

/** Protocol is a property of the connection, never inferred from a model's brand. */
export function modelProtocol(providerType: ProviderType, baseUrl: string): "openai_responses" | "openai_chat_completions" | "anthropic_messages" {
  if (providerType === "anthropic") return "anthropic_messages";
  try {
    const url = new URL(baseUrl);
    if (url.protocol === "https:" && url.hostname === "api.openai.com" && !url.username && !url.password && !url.search && !url.hash
      && (!url.port || url.port === "443") && /^\/v1\/?$/.test(url.pathname)) return "openai_responses";
  } catch { /* Invalid or local-compatible addresses stay on the configured compatible adapter. */ }
  return "openai_chat_completions";
}

export function invocationModelOptions(input: {
  providerType?: ProviderType; baseUrl?: string; modelId?: string; reasoningEffort?: ReasoningEffort; temperature?: number;
}): { temperature?: number; providerOptions?: StreamProviderOptions } {
  if (!input.providerType || !input.modelId) return { temperature: input.temperature };
  const official = modelProtocol(input.providerType, input.baseUrl ?? "") === "openai_responses";
  const id = input.modelId.toLowerCase();
  const reasoning = /^(?:gpt-[56](?:\.|-|$)|o[134](?:-|$))/.test(id);
  if (official && reasoning) {
    const effort = input.reasoningEffort;
    if (/^gpt-(?:6\.1-sol|6-astra)(?:-|$)/.test(id) && (effort === "disabled" || effort === "minimal")) {
      throw new Error(`reasoning_effort_unsupported:${input.modelId}:${effort}`);
    }
    const mapped = effort === "disabled" ? "none" : effort === "auto" ? undefined : effort;
    return {
      ...(mapped === "none" ? { temperature: input.temperature } : {}),
      providerOptions: { openai: { store: false, forceReasoning: true, ...(mapped ? { reasoningEffort: mapped } : {}) } },
    };
  }
  return {
    temperature: input.temperature,
    providerOptions: official
      ? { openai: { store: false } }
      : reasoningProviderOptions(input.providerType, input.modelId, input.reasoningEffort),
  };
}

export function reasoningProviderOptions(
  providerType: "openai_compatible" | "anthropic",
  modelId: string,
  effort?: ReasoningEffort,
): StreamProviderOptions | undefined {
  if (!effort || effort === "auto") return undefined;
  const family = resolveReasoningProfile(providerType, modelId).family;

  if (providerType === "anthropic") {
    if (effort === "disabled") return { anthropic: { thinking: { type: "disabled" as const } } };
    return {
      anthropic: {
        effort,
        ...(family === "deepseek" ? { thinking: { type: "enabled" as const } } : {}),
      },
    };
  }

  if (effort === "disabled") {
    if (family === "deepseek") return { openaiCompatible: { thinking: { type: "disabled" } } };
    if (["qwen", "kimi", "glm"].includes(family)) {
      return { openaiCompatible: { enable_thinking: false } };
    }
    return { openaiCompatible: { reasoningEffort: "none" } };
  }

  return {
    openaiCompatible: {
      reasoningEffort: effort,
      ...(family === "deepseek" ? { thinking: { type: "enabled" } } : {}),
      ...(["qwen", "kimi", "glm"].includes(family) ? { enable_thinking: true } : {}),
    },
  };
}

export function createAiSdkModel(input: {
  providerType: "openai_compatible" | "anthropic";
  baseUrl: string;
  apiKey: string;
  modelId: string;
  fetchImpl: FetchLike;
}) {
  if (modelProtocol(input.providerType, input.baseUrl) === "openai_responses") {
    return createOpenAI({ apiKey: input.apiKey, baseURL: input.baseUrl.replace(/\/$/, ""), fetch: input.fetchImpl as typeof fetch }).responses(input.modelId);
  }
  return input.providerType === "anthropic"
    ? createAnthropic({ apiKey: input.apiKey, baseURL: `${input.baseUrl}/v1`, fetch: input.fetchImpl as typeof fetch })(input.modelId)
    : createOpenAICompatible({
        name: "openai-compatible",
        apiKey: input.apiKey,
        baseURL: input.baseUrl,
        fetch: input.fetchImpl as typeof fetch,
      })(input.modelId);
}

/** 把供应商错误翻译成可读分类（鉴权/限流/网络），UI 直接展示（docs/03 §7.1） */
export function describeGatewayError(err: unknown): string {
  const detail = classifyProviderError(err, "provider_stream");
  const status = detail.statusCode === undefined ? "" : `（${detail.statusCode}）`;
  if (detail.category === "authentication" || detail.category === "permission") return `鉴权失败${status}：${detail.message}`;
  if (detail.category === "rate_limit") return `限流${status}：${detail.message}`;
  if (detail.category === "cancelled") return "请求已中止";
  if (detail.category === "network") return `网络错误：${detail.message}`;
  return `供应商错误${status}：${detail.message}`;
}

/**
 * ModelGateway 的 Vercel AI SDK 实现；编排/路由层永远不直接碰供应商 API（docs/02 §6）。
 * 传入的 fetch 决定出站代理（见 net.ts）。
 */
export function makeAiSdkGateway(fetchImpl: FetchLike): ModelGateway {
  return async function* (req) {
  try {
    const options = invocationModelOptions(req);
    const model = createAiSdkModel({ ...req, fetchImpl });
    const result = streamText({
      model,
      system: req.system,
      messages: req.messages,
      ...options,
      maxOutputTokens: req.maxOutputTokens,
      // Retain only explicit accounting fields before this SDK version strips newer usage details.
      includeRawChunks: true,
      abortSignal: req.signal,
      // Group chat does not yet use the Phase 2 single-Agent retry policy, but
      // SDK-internal retries must still stay disabled and observable.
      maxRetries: 0,
    });
    let usage: TokenUsage | undefined;
    let rawUsage: TokenUsage | undefined;
    let finishReason: string | undefined;
    let failed = false;
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        yield { type: "delta", text: part.text };
      } else if (part.type === "raw") {
        rawUsage = rawTokenUsageOf(part.rawValue) ?? rawUsage;
      } else if (part.type === "finish") {
        usage = { ...tokenUsageOf(part.totalUsage), ...rawUsage };
        finishReason = part.finishReason;
      } else if (part.type === "error") {
        failed = true;
        yield {
          type: "error",
          message: describeGatewayError(part.error),
          detail: classifyProviderError(part.error, "provider_stream"),
        };
      }
    }
    if (!failed) {
      const response = await result.response;
      yield { type: "done", usage, requestId: response.headers?.["x-request-id"] ?? response.id, finishReason };
    }
  } catch (err) {
    yield {
      type: "error",
      message: describeGatewayError(err),
      detail: classifyProviderError(err, "provider_connect"),
    };
  }
  };
}

/** SDK usage is final per invocation. Cache/reasoning subsets remain separate for the billing adapter. */
export function tokenUsageOf(raw: {
  inputTokens?: number; outputTokens?: number; totalTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
  outputTokenDetails?: { reasoningTokens?: number };
}): TokenUsage {
  return {
    inputTokens: raw.inputTokens, outputTokens: raw.outputTokens, totalTokens: raw.totalTokens,
    cachedInputTokens: raw.inputTokenDetails?.cacheReadTokens, cacheWriteTokens: raw.inputTokenDetails?.cacheWriteTokens,
    reasoningTokens: raw.outputTokenDetails?.reasoningTokens,
  };
}

const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const tokens = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Read minimal public usage from the SDK raw-chunk seam; never retain the raw chunk itself. */
export function rawTokenUsageOf(value: unknown): (TokenUsage & { unsupportedBillingDimensions?: string[] }) | undefined {
  const chunk = record(value);
  if (chunk?.object === "chat.completion.chunk") {
    const usage = record(chunk.usage);
    if (!usage) return undefined;
    const input = record(usage.prompt_tokens_details), output = record(usage.completion_tokens_details);
    const fields = { inputTokens: tokens(usage.prompt_tokens), outputTokens: tokens(usage.completion_tokens), totalTokens: tokens(usage.total_tokens),
      cachedInputTokens: tokens(input?.cached_tokens ?? usage.prompt_cache_hit_tokens), cacheWriteTokens: tokens(input?.cache_write_tokens), reasoningTokens: tokens(output?.reasoning_tokens) };
    return Object.fromEntries(Object.entries(fields).filter(([, count]) => count !== undefined));
  }
  if (!chunk || !["response.completed", "response.incomplete", "response.failed"].includes(String(chunk.type))) return undefined;
  const response = record(chunk.response);
  const usage = record(response?.usage);
  if (!usage) return undefined;
  const input = record(usage.input_tokens_details);
  const output = record(usage.output_tokens_details);
  const writes = record(input?.cache_write_tokens_details);
  const unsupportedBillingDimensions: string[] = [];
  if ((tokens(writes?.ttl_12h_tokens) ?? 0) > 0) unsupportedBillingDimensions.push("openai_cache_write_12h");
  if (response?.service_tier && !["default", "standard", "auto"].includes(String(response.service_tier))) unsupportedBillingDimensions.push(`openai_service_tier:${String(response.service_tier)}`);
  const result: TokenUsage & { unsupportedBillingDimensions?: string[] } = {};
  const fields = {
    inputTokens: tokens(usage.input_tokens), outputTokens: tokens(usage.output_tokens), totalTokens: tokens(usage.total_tokens),
    cachedInputTokens: tokens(input?.cached_tokens), cacheWriteTokens: tokens(input?.cache_write_tokens), reasoningTokens: tokens(output?.reasoning_tokens),
  };
  for (const [key, count] of Object.entries(fields)) if (count !== undefined) Object.assign(result, { [key]: count });
  if (unsupportedBillingDimensions.length) result.unsupportedBillingDimensions = unsupportedBillingDimensions;
  return result;
}
