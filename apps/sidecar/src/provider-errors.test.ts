import { describe, expect, it } from "bun:test";
import { classifyProviderError } from "./provider-errors";

describe("Provider error classification", () => {
  it("classifies transient and permanent HTTP failures with stable semantics", () => {
    expect(classifyProviderError({
      statusCode: 429,
      message: "slow down",
      responseHeaders: { "retry-after": "2" },
    }, "provider_connect")).toMatchObject({
      code: "provider_rate_limited",
      category: "rate_limit",
      phase: "provider_connect",
      retryable: true,
      retryAfterMs: 2_000,
    });
    expect(classifyProviderError({ statusCode: 503, message: "unavailable" }, "provider_stream"))
      .toMatchObject({ code: "provider_unavailable", category: "provider", retryable: true });
    expect(classifyProviderError({ statusCode: 401, message: "bad key" }, "provider_connect"))
      .toMatchObject({ code: "provider_authentication_failed", category: "authentication", retryable: false });
    expect(classifyProviderError({ statusCode: 400, message: "invalid schema" }, "provider_connect"))
      .toMatchObject({ code: "provider_invalid_request", category: "invalid_request", retryable: false });
  });

  it("fails closed for authorization, quota, cancellation, and unknown errors", () => {
    expect(classifyProviderError({ statusCode: 403, message: "forbidden" }, "provider_connect"))
      .toMatchObject({ code: "provider_authorization_failed", category: "permission", retryable: false });
    expect(classifyProviderError({
      statusCode: 429,
      code: "insufficient_quota",
      message: "quota exhausted",
    }, "provider_connect")).toMatchObject({
      code: "provider_quota_exhausted", retryable: false,
    });
    const abort = new Error("cancelled");
    abort.name = "AbortError";
    expect(classifyProviderError(abort, "provider_stream"))
      .toMatchObject({ code: "provider_cancelled", category: "cancelled", retryable: false });
    expect(classifyProviderError(new Error("malformed protocol"), "provider_stream"))
      .toMatchObject({ code: "provider_unknown_error", category: "unknown", retryable: false });
  });

  it("recognizes a real AI SDK network wrapper without trusting arbitrary retry hints", () => {
    const wrapped = Object.assign(new Error("Cannot connect to API"), {
      name: "AI_APICallError",
      isRetryable: true,
      cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
    });
    expect(classifyProviderError(wrapped, "provider_connect")).toMatchObject({
      code: "provider_network_error",
      category: "network",
      retryable: true,
    });
    expect(classifyProviderError({
      name: "ThirdPartyError",
      message: "please retry",
      isRetryable: true,
    }, "provider_connect")).toMatchObject({
      code: "provider_unknown_error",
      retryable: false,
    });
    expect(classifyProviderError(new TypeError("Cannot read properties of undefined"), "provider_stream"))
      .toMatchObject({ code: "provider_unknown_error", retryable: false });
    expect(classifyProviderError(Object.assign(new Error("Cannot connect to API"), {
      name: "AI_APICallError",
      isRetryable: true,
      cause: new TypeError("invalid adapter state"),
    }), "provider_connect")).toMatchObject({ code: "provider_unknown_error", retryable: false });
    for (const code of ["ETIMEDOUT", "ConnectionRefused", "ConnectionClosed", "FailedToOpenSocket"]) {
      expect(classifyProviderError(Object.assign(new Error("Cannot connect to API"), {
        name: "AI_APICallError",
        isRetryable: true,
        cause: Object.assign(new Error("Bun network failure"), { code }),
      }), "provider_connect")).toMatchObject({ code: "provider_network_error", retryable: true });
    }
    for (const message of ["invalid connection option", "socket configuration invalid"]) {
      expect(classifyProviderError(new TypeError(message), "provider_connect"))
        .toMatchObject({ code: "provider_unknown_error", retryable: false });
    }
  });
});
