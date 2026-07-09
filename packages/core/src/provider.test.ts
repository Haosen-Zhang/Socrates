import { describe, expect, it } from "bun:test";
import {
  buildTestRequest,
  classifyTestOutcome,
  resolveBaseUrl,
  validateProviderInput,
} from "./provider";

describe("validateProviderInput", () => {
  it("accepts minimal valid input", () => {
    expect(validateProviderInput({ name: "OpenAI", type: "openai_compatible" })).toBeNull();
  });
  it("rejects empty name and bad url", () => {
    expect(validateProviderInput({ name: "  ", type: "anthropic" })).not.toBeNull();
    expect(
      validateProviderInput({ name: "x", type: "anthropic", baseUrl: "not-a-url" }),
    ).not.toBeNull();
  });
});

describe("resolveBaseUrl", () => {
  it("defaults per type and trims trailing slashes", () => {
    expect(resolveBaseUrl("openai_compatible")).toBe("https://api.openai.com/v1");
    expect(resolveBaseUrl("anthropic", "")).toBe("https://api.anthropic.com");
    expect(resolveBaseUrl("openai_compatible", "https://api.deepseek.com/")).toBe(
      "https://api.deepseek.com",
    );
  });
});

describe("buildTestRequest", () => {
  it("openai-compatible uses bearer auth on /models", () => {
    const r = buildTestRequest("openai_compatible", "https://api.deepseek.com", "sk-x");
    expect(r.url).toBe("https://api.deepseek.com/models");
    expect(r.headers.Authorization).toBe("Bearer sk-x");
  });
  it("anthropic uses x-api-key on /v1/models", () => {
    const r = buildTestRequest("anthropic", "https://api.anthropic.com", "sk-a");
    expect(r.url).toBe("https://api.anthropic.com/v1/models");
    expect(r.headers["x-api-key"]).toBe("sk-a");
    expect(r.headers["anthropic-version"]).toBeString();
  });
});

describe("classifyTestOutcome", () => {
  it("classifies the full matrix", () => {
    expect(classifyTestOutcome(undefined)).toBe("network_error");
    expect(classifyTestOutcome(200)).toBe("ok");
    expect(classifyTestOutcome(401)).toBe("auth_failed");
    expect(classifyTestOutcome(403)).toBe("auth_failed");
    expect(classifyTestOutcome(404)).toBe("error");
    expect(classifyTestOutcome(500)).toBe("error");
  });
});
