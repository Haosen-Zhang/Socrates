import { describe, expect, it } from "bun:test";
import { atomicToDecimal, decimalToAtomic, priceUsage, requestCostUpperBound, type PriceSnapshot } from "./cost";

const price: PriceSnapshot = {
  id: "p1", providerConnectionId: "p", upstreamProvider: "fixture", modelId: "model", protocol: "chat_completions",
  baseUrl: "https://fixture.invalid/v1", serviceTier: "default", currency: "USD", rates: { input: "0.50", cacheRead: "0.10", cacheWrite: "0.75", output: "2.00" },
  source: "user_confirmed", sourceUrl: "local:user", sourceVersion: "test-v1", fetchedAt: "2026-11-06T00:00:00.000Z", validFrom: "2026-01-01T00:00:00.000Z", validUntil: null,
  contentHash: "fixture", billingMode: "metered", explicitlyFree: false,
  usageSemantics: { inputIncludesCacheRead: true, inputIncludesCacheWrite: true, outputIncludesReasoning: true },
  unsupportedDimensions: [], tiers: [],
};

describe("fixed precision model costs", () => {
  it("preserves small amounts and refuses floating or negative budget input", () => {
    expect(decimalToAtomic("0.00805")).toBe("8050000000");
    expect(atomicToDecimal("8050000000")).toBe("0.00805");
    expect(decimalToAtomic("0.000000000001")).toBe("1");
    expect(() => decimalToAtomic("-0.1")).toThrow();
    expect(() => decimalToAtomic("1e-4")).toThrow();
    expect(() => decimalToAtomic("0.0000000000001")).toThrow();
  });
  it("prices disjoint cache buckets and does not add included reasoning twice (T01)", () => {
    const result = priceUsage({ inputTokens: 10000, cachedInputTokens: 3000, cacheWriteTokens: 1000, outputTokens: 2000, reasoningTokens: 500 }, price);
    expect(result.status).toBe("priced");
    expect(result.amount?.atomic).toBe("8050000000");
    expect(result.lineItems.map(item => [item.kind, item.quantity, item.amount.atomic])).toEqual([
      ["input", 6000, "3000000000"], ["cache_read", 3000, "300000000"], ["cache_write", 1000, "750000000"], ["output", 2000, "4000000000"],
    ]);
  });
  it("adapts providers whose input excludes cache writes", () => {
    const result = priceUsage({ inputTokens: 9000, cachedInputTokens: 3000, cacheWriteTokens: 1000, outputTokens: 2000, reasoningTokens: 500 }, {
      ...price, usageSemantics: { ...price.usageSemantics, inputIncludesCacheWrite: false },
    });
    expect(result.amount?.atomic).toBe("8050000000");
  });
  it("never prices an impossible overlapping usage or absent usage as zero", () => {
    expect(priceUsage(undefined, price).status).toBe("outcome_unknown");
    expect(priceUsage({ inputTokens: 2, cachedInputTokens: 3, outputTokens: 1 }, price).status).toBe("partially_priced");
    expect(priceUsage({ inputTokens: 10, outputTokens: 2 }, null).status).toBe("unpriced");
    expect(priceUsage({ inputTokens: -1, outputTokens: 2 }, price).status).toBe("partially_priced");
  });
  it("keeps known line items when one rate is missing", () => {
    const result = priceUsage({ inputTokens: 100, cachedInputTokens: 50, outputTokens: 20 }, { ...price, rates: { input: "1", output: "2" } });
    expect(result.status).toBe("partially_priced");
    expect(result.amount?.atomic).toBe("90000000");
    expect(result.unknownItems).toContain("cache_read");
  });
  it("keeps distinct missing cache counts unknown rather than pricing them as uncached input", () => {
    const result = priceUsage({ inputTokens: 100, outputTokens: 10 }, price);
    expect(result.status).toBe("partially_priced");
    expect(result.amount?.atomic).toBe("20000000");
    expect(result.unknownItems).toContain("cache_read_quantity");
    expect(result.unknownItems).toContain("cache_write_quantity");
    expect(priceUsage({ inputTokens: 100, outputTokens: 10 }, { ...price, rates: { input: "0.5", output: "2" } }).status).toBe("priced");
    const exclusive = priceUsage({ inputTokens: 100, outputTokens: 10 }, { ...price, usageSemantics: { ...price.usageSemantics, inputIncludesCacheRead: false, inputIncludesCacheWrite: false } });
    expect(exclusive.amount?.atomic).toBe("70000000");
  });
  it("exposes unsupported provider billing dimensions alongside the known subtotal", () => {
    const result = priceUsage({ inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10, unsupportedBillingDimensions: ["unreported_audio_surcharge"] }, price);
    expect(result.status).toBe("partially_priced");
    expect(result.amount?.atomic).toBe("70000000");
    expect(result.unknownItems).toContain("unreported_audio_surcharge");
    const ttl = priceUsage({ inputTokens: 10000, cachedInputTokens: 3000, cacheWriteTokens: 1000, outputTokens: 2000, unsupportedBillingDimensions: ["openai_cache_write_12h"] }, price);
    expect(ttl.amount?.atomic).toBe("7300000000");
    expect(ttl.lineItems.some(item => item.kind === "cache_write")).toBe(false);
    expect(priceUsage({ inputTokens: 100, outputTokens: 10, unsupportedBillingDimensions: ["openai_service_tier:priority"] }, price).amount).toBeNull();
  });
  it("uses the highest applicable cache and context-tier rates for admission", () => {
    const bound = requestCostUpperBound({ ...price, tiers: [{ minInputTokens: 1000, rates: { input: "3", output: "5", cacheWrite: "4" } }] }, 2000, 100);
    expect(bound?.atomic).toBe("8500000000");
  });
  it("refuses an upper bound for unsupported modalities or unbounded reasoning", () => {
    expect(requestCostUpperBound({ ...price, unsupportedDimensions: ["audio"] }, 100, 10)).toBeNull();
    expect(requestCostUpperBound({ ...price, usageSemantics: { ...price.usageSemantics, outputIncludesReasoning: false } }, 100, 10)).toBeNull();
    expect(requestCostUpperBound({ ...price, usageSemantics: { ...price.usageSemantics, inputIncludesCacheWrite: false } }, 100, 10)).toBeNull();
  });
});
