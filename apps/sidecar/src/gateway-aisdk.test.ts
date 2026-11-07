import { describe, expect, it } from "bun:test";
import { describeGatewayError, makeAiSdkGateway, reasoningProviderOptions, createAiSdkModel, invocationModelOptions, rawTokenUsageOf } from "./gateway-aisdk";
import { jsonSchema, stepCountIs, streamText, tool } from "ai";

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

describe("official Responses adapter contract", () => {
  it("routes official OpenAI through Responses, applies reasoning/output controls and preserves detailed usage", async () => {
    let requestUrl = "";
    let requestBody: Record<string, unknown> = {};
    const gateway = makeAiSdkGateway(async (url, init) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init?.body));
      const response = { id: "resp_fixture", object: "response", created_at: 1, status: "completed", model: "gpt-6.1-sol", output: [],
        usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 1 }, output_tokens: 6, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 16 } };
      const parts = [
        { type: "response.created", response: { ...response, status: "in_progress", usage: null } },
        { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_fixture", role: "assistant", content: [] } },
        { type: "response.output_text.delta", item_id: "msg_fixture", output_index: 0, content_index: 0, delta: "ok" },
        { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_fixture", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] } },
        { type: "response.completed", response },
      ];
      return new Response(parts.map(part => `data: ${JSON.stringify(part)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream", "x-request-id": "req_fixture" },
      });
    });
    const events = [];
    for await (const event of gateway({
      providerType: "openai_compatible", baseUrl: "https://api.openai.com/v1", apiKey: "test-fixture-key", modelId: "gpt-6.1-sol",
      temperature: 0.2, reasoningEffort: "high", maxOutputTokens: 128, messages: [{ role: "user", content: "hello" }],
    })) events.push(event);
    expect(requestUrl).toBe("https://api.openai.com/v1/responses");
    expect(requestBody).toMatchObject({ model: "gpt-6.1-sol", max_output_tokens: 128, reasoning: { effort: "high" }, store: false });
    expect(requestBody.temperature).toBeUndefined();
    expect(events.find(event => event.type === "done")).toMatchObject({ type: "done", requestId: "req_fixture", usage: {
      inputTokens: 10, outputTokens: 6, totalTokens: 16, cachedInputTokens: 3, cacheWriteTokens: 1, reasoningTokens: 2,
    } });
  });

  it("preserves cache-write accounting from SDK raw chunks and marks unsupported write lifetimes or tiers", () => {
    expect(rawTokenUsageOf({ type: "response.completed", response: { usage: {
      input_tokens: 10000, input_tokens_details: { cached_tokens: 3000, cache_write_tokens: 1000 }, output_tokens: 2000, output_tokens_details: { reasoning_tokens: 500 },
    } } })).toMatchObject({ inputTokens: 10000, cachedInputTokens: 3000, cacheWriteTokens: 1000, outputTokens: 2000, reasoningTokens: 500 });
    expect(rawTokenUsageOf({ type: "response.completed", response: { service_tier: "priority", usage: {
      input_tokens: 10, input_tokens_details: { cache_write_tokens: 4, cache_write_tokens_details: { ttl_12h_tokens: 2 } }, output_tokens: 2,
    } } })?.unsupportedBillingDimensions).toEqual(["openai_cache_write_12h", "openai_service_tier:priority"]);
    expect(rawTokenUsageOf({ type: "response.output_text.delta", delta: "private text" })).toBeUndefined();
  });

  it("retains explicit compatible cache-write zero while preserving omitted cache fields as unknown", () => {
    expect(rawTokenUsageOf({ object: "chat.completion.chunk", choices: [], usage: {
      prompt_tokens: 100, completion_tokens: 50, total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 },
    } })).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
    expect(rawTokenUsageOf({ object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 100, completion_tokens: 50 } }))
      .toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it("rejects unsupported official reasoning controls before any request", async () => {
    let requests = 0;
    const gateway = makeAiSdkGateway(async () => { requests++; throw new Error("unexpected_network"); });
    const events = [];
    for await (const event of gateway({ providerType: "openai_compatible", baseUrl: "https://api.openai.com/v1", apiKey: "fixture", modelId: "gpt-6.1-sol",
      reasoningEffort: "disabled", messages: [{ role: "user", content: "hi" }] })) events.push(event);
    expect(requests).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", message: expect.stringContaining("reasoning_effort_unsupported") }));
  });

  it("official provider exposes real function calls with stable call IDs to the existing single-step tool seam", async () => {
    let body: Record<string, unknown> = {};
    let executed: unknown;
    const profile = { providerType: "openai_compatible" as const, baseUrl: "https://api.openai.com/v1", modelId: "gpt-6.1-sol", reasoningEffort: "high" as const, temperature: 0.7 };
    const model = createAiSdkModel({ ...profile, apiKey: "fixture-only", fetchImpl: async (url, init) => {
      expect(String(url)).toBe("https://api.openai.com/v1/responses");
      body = JSON.parse(String(init?.body));
      const item = { type: "function_call", id: "fc_fixture", call_id: "call_stable", name: "read_fixture", arguments: '{"path":"safe.txt"}', status: "completed" };
      const parts = [
        { type: "response.created", response: { id: "resp_tools", created_at: 1, model: profile.modelId } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 6, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 2 } } } },
      ];
      return new Response(parts.map(part => `data: ${JSON.stringify(part)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    } });
    const result = streamText({ model, ...invocationModelOptions(profile), maxOutputTokens: 128, maxRetries: 0, stopWhen: stepCountIs(1),
      toolApproval: { read_fixture: "not-applicable" },
      messages: [{ role: "user", content: "read fixture" }], tools: { read_fixture: tool({
        description: "Read the temporary fixture", inputSchema: jsonSchema<{ path: string }>({ type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }),
        execute: async (input, options) => { executed = { input, callId: options.toolCallId }; return "fixture content"; },
      }) } });
    const parts = [];
    for await (const part of result.fullStream) parts.push(part);
    expect(body).toMatchObject({ reasoning: { effort: "high" }, max_output_tokens: 128, tools: [expect.objectContaining({ type: "function", name: "read_fixture" })] });
    expect(body.temperature).toBeUndefined();
    expect(parts.filter(part => part.type === "error" || part.type === "tool-error")).toEqual([]);
    expect(parts.find(part => part.type === "tool-call")).toMatchObject({ toolCallId: "call_stable", toolName: "read_fixture" });
    expect(executed).toEqual({ input: { path: "safe.txt" }, callId: "call_stable" });
  });
});
