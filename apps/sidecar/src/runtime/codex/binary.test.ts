import { describe, expect, it } from "bun:test";
import { configuredCodexBinary } from "./binary";

describe("configuredCodexBinary", () => {
  it("rejects relative configured binaries instead of searching PATH", () => {
    const previous = process.env.SOCRATES_CODEX_BINARY;
    process.env.SOCRATES_CODEX_BINARY = "codex";
    try {
      expect(() => configuredCodexBinary()).toThrow("codex_binary_invalid");
    } finally {
      if (previous === undefined) delete process.env.SOCRATES_CODEX_BINARY;
      else process.env.SOCRATES_CODEX_BINARY = previous;
    }
  });
});
