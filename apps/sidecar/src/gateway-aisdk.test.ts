import { describe, expect, it } from "bun:test";
import { describeGatewayError, makeAiSdkGateway, reasoningProviderOptions } from "./gateway-aisdk";

describe("describeGatewayError", () => {
  it("classifies auth / rate-limit / provider / network errors", () => {
    expect(describeGatewayError({ statusCode: 401, message: "bad key" })).toStartWith("鉴权失败（401）");
    expect(describeGatewayError({ statusCode: 403, message: "no" })).toStartWith("鉴权失败（403）");
    expect(describeGatewayError({ statusCode: 429, message: "slow down" })).toStartWith("限流（429）");
    expect(describeGatewayError({ statusCode: 500, message: "oops" })).toStartWith("供应商错误（500）");
    expect(describeGatewayError(new TypeError("fetch failed"))).toStartWith("网络错误");
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(describeGatewayError(abort)).toBe("请求已中止");
  });
});

describe("reasoning provider options", () => {
  it("maps the canonical effort to each Provider's actual request shape", () => {
    expect(reasoningProviderOptions("openai_compatible", "gpt-5.4", "high")).toEqual({
      openaiCompatible: { reasoningEffort: "high" },
    });
    expect(reasoningProviderOptions("openai_compatible", "gpt-5.4", "disabled")).toEqual({
      openaiCompatible: { reasoningEffort: "none" },
    });
    expect(reasoningProviderOptions("openai_compatible", "deepseek-v4-pro", "max")).toEqual({
      openaiCompatible: { reasoningEffort: "max", thinking: { type: "enabled" } },
    });
    expect(reasoningProviderOptions("openai_compatible", "deepseek-v4-pro", "disabled")).toEqual({
      openaiCompatible: { thinking: { type: "disabled" } },
    });
    expect(reasoningProviderOptions("openai_compatible", "qwen3.7-plus", "disabled")).toEqual({
      openaiCompatible: { enable_thinking: false },
    });
    expect(reasoningProviderOptions("anthropic", "claude-opus-4-8", "xhigh")).toEqual({
      anthropic: { effort: "xhigh" },
    });
    expect(reasoningProviderOptions("openai_compatible", "gpt-5.4", "auto")).toBeUndefined();
  });

  it("serializes DeepSeek reasoning controls into the final compatible HTTP body", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const gateway = makeAiSdkGateway(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      const stream = [
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":0,"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":0,"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
        "data: [DONE]",
        "",
      ].join("\n\n");
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    });

    for await (const _event of gateway({
      providerType: "openai_compatible",
      baseUrl: "https://example.invalid/v1",
      apiKey: "sk-test",
      modelId: "deepseek-v4-pro",
      reasoningEffort: "max",
      messages: [{ role: "user", content: "hello" }],
    })) {
      // Drain the stream so the SDK serializes and sends the request.
    }

    expect(requestBody).toMatchObject({
      model: "deepseek-v4-pro",
      reasoning_effort: "max",
      thinking: { type: "enabled" },
    });
  });
});
