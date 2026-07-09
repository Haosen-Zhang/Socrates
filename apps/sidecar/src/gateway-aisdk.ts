import { streamText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { ModelGateway } from "@socrates/core";

/** ModelGateway 的 Vercel AI SDK 实现；编排/路由层永远不直接碰供应商 API（docs/02 §6） */
export const aiSdkGateway: ModelGateway = async function* (req) {
  const model =
    req.providerType === "anthropic"
      ? createAnthropic({ apiKey: req.apiKey, baseURL: `${req.baseUrl}/v1` })(req.modelId)
      : createOpenAICompatible({ name: "openai-compatible", apiKey: req.apiKey, baseURL: req.baseUrl })(
          req.modelId,
        );
  try {
    const result = streamText({
      model,
      system: req.system,
      messages: req.messages,
      temperature: req.temperature,
    });
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        yield { type: "delta", text: part.text };
      } else if (part.type === "finish") {
        usage = { inputTokens: part.totalUsage.inputTokens, outputTokens: part.totalUsage.outputTokens };
      } else if (part.type === "error") {
        yield { type: "error", message: String(part.error).slice(0, 300) };
      }
    }
    yield { type: "done", usage };
  } catch (err) {
    yield { type: "error", message: String(err).slice(0, 300) };
  }
};
