import { describe, expect, it } from "bun:test";
import { describeGatewayError, reasoningProviderOptions } from "./gateway-aisdk";

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
  it("maps an explicitly supported effort only for the compatible adapter", () => {
    expect(reasoningProviderOptions("openai_compatible", "high")).toEqual({ "openai-compatible": { reasoningEffort: "high" } });
    expect(reasoningProviderOptions("anthropic", "high")).toBeUndefined();
    expect(reasoningProviderOptions("openai_compatible")).toBeUndefined();
  });
});
