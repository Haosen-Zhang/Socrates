import { describe, expect, it } from "bun:test";
import { contextWindowUsage } from "./contextWindowUsage";

describe("contextWindowUsage", () => {
  it("computes an honest ratio and preserves over-capacity diagnostics", () => {
    expect(contextWindowUsage(25_000, 100_000)).toMatchObject({ percent: 25, overCapacity: false });
    expect(contextWindowUsage(120_000, 100_000)).toMatchObject({ percent: 120, overCapacity: true });
  });
  it("returns unavailable when provider or model metadata is missing", () => {
    expect(contextWindowUsage(null, 100_000)).toBeNull();
    expect(contextWindowUsage(1_000, undefined)).toBeNull();
  });
});
