import { describe, expect, it } from "bun:test";
import {
  mergeModelCapabilities,
  resolveReasoningProfile,
  supportsRequest,
  UNKNOWN_MODEL_CAPABILITIES,
} from "./model-capabilities";

describe("model capabilities", () => {
  it("keeps unknown capabilities unavailable", () => {
    expect(UNKNOWN_MODEL_CAPABILITIES.imageInput).toBe("unknown");
    expect(supportsRequest(UNKNOWN_MODEL_CAPABILITIES, { imageInput: true })).toEqual({
      ok: false,
      missing: ["imageInput"],
    });
  });

  it("allows explicit user overrides without inventing unrelated capabilities", () => {
    const merged = mergeModelCapabilities(UNKNOWN_MODEL_CAPABILITIES, { imageInput: true, toolCalling: false });
    expect(merged.imageInput).toBe(true);
    expect(merged.toolCalling).toBe(false);
    expect(merged.fileInput).toBe("unknown");
  });

  it("maps common model families to their supported effort controls", () => {
    expect(resolveReasoningProfile("openai_compatible", "gpt-5.4").efforts).toEqual([
      "auto", "disabled", "low", "medium", "high", "xhigh",
    ]);
    expect(resolveReasoningProfile("openai_compatible", "openai/gpt-5.4").family).toBe("openai");
    expect(resolveReasoningProfile("openai_compatible", "gpt-5-pro").efforts).toEqual([
      "auto", "disabled", "low", "medium", "high", "xhigh",
    ]);
    expect(resolveReasoningProfile("openai_compatible", "gpt-4o")).toEqual({
      family: "openai",
      efforts: ["auto", "disabled"],
      defaultEffort: "auto",
    });
    expect(resolveReasoningProfile("openai_compatible", "deepseek-v4-pro").efforts).toEqual([
      "auto", "disabled", "high", "max",
    ]);
    expect(resolveReasoningProfile("anthropic", "claude-opus-4-8").efforts).toEqual([
      "auto", "low", "medium", "high", "xhigh", "max",
    ]);
    expect(resolveReasoningProfile("openai_compatible", "gemini-3-flash").efforts).toEqual([
      "auto", "minimal", "low", "medium", "high",
    ]);
    expect(resolveReasoningProfile("openai_compatible", "qwen3.7-plus").efforts).toEqual([
      "auto", "disabled",
    ]);
    expect(resolveReasoningProfile("openai_compatible", "kimi-k2.6").efforts).toEqual([
      "auto", "disabled",
    ]);
    expect(resolveReasoningProfile("openai_compatible", "llama-4-scout").efforts).toEqual(["auto", "disabled"]);
  });

  it("preserves explicit custom/open-weight capability overrides with a required auto choice", () => {
    expect(resolveReasoningProfile("openai_compatible", "company-model")).toEqual({
      family: "custom",
      efforts: ["auto", "disabled"],
      defaultEffort: "auto",
    });
    expect(resolveReasoningProfile("openai_compatible", "company-model", ["low", "high"])).toEqual({
      family: "custom",
      efforts: ["auto", "low", "high"],
      defaultEffort: "auto",
    });
  });
});
