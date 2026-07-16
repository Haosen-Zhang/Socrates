import { describe, expect, it } from "bun:test";
import { mergeModelCapabilities, supportsRequest, UNKNOWN_MODEL_CAPABILITIES } from "./model-capabilities";

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
});
