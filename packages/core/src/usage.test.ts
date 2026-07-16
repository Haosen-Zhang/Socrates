import { describe, expect, it } from "bun:test";
import { UNAVAILABLE_USAGE } from "./usage";

describe("normalized usage", () => {
  it("represents missing provider data as unavailable nulls, never zero", () => {
    expect(UNAVAILABLE_USAGE.source).toBe("unavailable");
    expect(UNAVAILABLE_USAGE.inputTokens).toBeNull();
    expect(UNAVAILABLE_USAGE.outputTokens).toBeNull();
    expect(UNAVAILABLE_USAGE.cost).toBeNull();
  });
});
