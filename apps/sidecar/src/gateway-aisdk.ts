import { streamText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { ModelGateway } from "@socrates/core";
import type { FetchLike } from "./net";

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
  const model =
    req.providerType === "anthropic"
      ? createAnthropic({ apiKey: req.apiKey, baseURL: `${req.baseUrl}/v1`, fetch: fetchImpl as typeof fetch })(
          req.modelId,
        )
      : createOpenAICompatible({
          name: "openai-compatible",
          apiKey: req.apiKey,
          baseURL: req.baseUrl,
          fetch: fetchImpl as typeof fetch,
        })(req.modelId);
  try {
    const result = streamText({
      model,
      system: req.system,
      messages: req.messages,
      temperature: req.temperature,
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
