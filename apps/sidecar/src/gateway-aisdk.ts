import { streamText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { resolveReasoningProfile, type ModelGateway, type ReasoningEffort } from "@socrates/core";
import type { FetchLike } from "./net";

type StreamProviderOptions = NonNullable<Parameters<typeof streamText>[0]["providerOptions"]>;

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
  const e = err as { statusCode?: number; status?: number; name?: string; message?: string } | null;
  const status = e?.statusCode ?? e?.status;
  const detail = (e?.message ?? String(err)).slice(0, 200);
  if (status === 401 || status === 403) return `鉴权失败（${status}）：${detail}`;
  if (status === 429) return `限流（429）：${detail}`;
  if (status !== undefined) return `供应商错误（${status}）：${detail}`;
  if (e?.name === "AbortError") return "请求已中止";
  return `网络错误：${detail}`;
}

/**
 * ModelGateway 的 Vercel AI SDK 实现；编排/路由层永远不直接碰供应商 API（docs/02 §6）。
 * 传入的 fetch 决定出站代理（见 net.ts）。
 */
export function makeAiSdkGateway(fetchImpl: FetchLike): ModelGateway {
  return async function* (req) {
  const model = createAiSdkModel({
    providerType: req.providerType,
    baseUrl: req.baseUrl,
    apiKey: req.apiKey,
    modelId: req.modelId,
    fetchImpl,
  });
  try {
    const result = streamText({
      model,
      system: req.system,
      messages: req.messages,
      temperature: req.temperature,
      providerOptions: reasoningProviderOptions(req.providerType, req.modelId, req.reasoningEffort),
      abortSignal: req.signal,
    });
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        yield { type: "delta", text: part.text };
      } else if (part.type === "finish") {
        usage = { inputTokens: part.totalUsage.inputTokens, outputTokens: part.totalUsage.outputTokens };
      } else if (part.type === "error") {
        yield { type: "error", message: describeGatewayError(part.error) };
      }
    }
    yield { type: "done", usage };
  } catch (err) {
    yield { type: "error", message: describeGatewayError(err) };
  }
  };
}
