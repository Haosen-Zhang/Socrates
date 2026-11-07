import { afterEach, expect, it } from "bun:test";
import { openDb } from "../db";
import { PricingStore } from "./pricing-store";
import type { Database } from "bun:sqlite";
import type { PriceInput } from "@socrates/core";

const dbs: Database[] = []; afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const input: PriceInput = { providerConnectionId: "proxy", upstreamProvider: "openai", modelId: "gpt-5", baseUrl: "https://proxy.invalid/v1", protocol: "chat_completions", currency: "USD", rates: { input: "1", output: "2" }, source: "user_confirmed", sourceVersion: "user:v1", fetchedAt: "2026-11-06T00:00:00Z", validFrom: "2026-01-01T00:00:00Z" };
function setup() { const db = openDb(":memory:"); dbs.push(db); return new PricingStore(db); }

it("automatically supplies official reference rates for the configured OpenAI models without one-by-one input", () => {
  const prices = setup();
  const identity = { providerConnectionId: "official", modelId: "gpt-6-luna", baseUrl: "https://api.openai.com/v1", protocol: "openai_responses" };
  expect(prices.resolveAutomatic(identity)).toMatchObject({ source: "official", rates: { input: "0.1", output: "0.5", cacheRead: "0.01", cacheWrite: "0.125" }, estimateReason: "official_reference" });
  expect(prices.resolveAutomatic({ ...identity, modelId: "gpt-5.6-luna" })).toMatchObject({ rates: { input: "0.2", output: "1.2", cacheRead: "0.02", cacheWrite: "0.25" } });
  expect(prices.resolveAutomatic(identity).id).toBe(prices.resolveAutomatic(identity).id);
});

it("labels proxy and unknown-model presets as estimates, while a single model override applies to all future calls", () => {
  const prices = setup(), identity = { providerConnectionId: "proxy", modelId: "unlisted-model", baseUrl: "https://proxy.invalid/v1", protocol: "openai_chat_completions" };
  expect(prices.resolveAutomatic(identity)).toMatchObject({ source: "preset_estimate", rates: { input: "1", output: "5" } });
  const custom = prices.save({ ...identity, rates: { input: "0.4", output: "2" }, currency: "USD", source: "user_confirmed", sourceVersion: "custom" });
  expect(prices.resolveAutomatic(identity).id).toBe(custom.id);
  expect(prices.resolveAutomatic({ ...identity, modelId: "gpt-6-luna" }).source).toBe("preset_estimate");
});

it("recognizes the documented DeepSeek alias and separates peak-reference and weekend off-peak snapshots", () => {
  const prices = setup(), identity = { providerConnectionId: "deepseek", modelId: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com", protocol: "openai_chat_completions" };
  expect(prices.resolveAutomatic(identity, "2026-11-07T08:00:00Z")).toMatchObject({ source: "official", rates: { input: "0.15", output: "0.6", cacheRead: "0.003" } });
  expect(prices.resolveAutomatic(identity, "2026-11-09T08:00:00Z")).toMatchObject({ rates: { input: "0.3", output: "1.2", cacheRead: "0.006" } });
});

it("resolves by connection+model+endpoint+protocol+tier without reusing a namesake official price", () => {
  const prices = setup(), p = prices.save(input);
  expect(prices.resolve(input)?.id).toBe(p.id);
  expect(prices.resolve({ ...input, providerConnectionId: "other" })).toBeNull();
  expect(prices.resolve({ ...input, baseUrl: "https://api.openai.com/v1" })).toBeNull();
  expect(prices.resolve({ ...input, protocol: "responses" })).toBeNull();
  expect(prices.resolve({ ...input, serviceTier: "priority" })).toBeNull();
});
it("prefers user-confirmed rates, freezes snapshots and surfaces source conflicts", () => {
  const prices = setup(), confirmed = prices.save(input);
  prices.save({ ...input, source: "verified_catalog", sourceVersion: "catalog-new", rates: { input: "99", output: "99" } });
  expect(prices.resolve(input)?.id).toBe(confirmed.id);
  expect(prices.get(confirmed.id)?.rates.input).toBe("1");
  expect(prices.conflicts(input)).toHaveLength(2);
  expect(() => prices.save({ ...input, rates: { input: "0", output: "0" } })).toThrow("free_price_requires_confirmation");
  expect(() => prices.save({ ...input, source: "verified_catalog", rates: { input: "0", output: "2" } })).toThrow("catalog_zero_rate_requires_confirmation");
});
it("rejects unsafe source fields and malformed data without dropping unknown future fields", () => {
  const prices = setup();
  expect(() => prices.save({ ...input, baseUrl: "https://user:secret@example.invalid" })).toThrow("price_endpoint_credentials_forbidden");
  expect(() => prices.save({ ...input, rates: { input: "NaN", output: "1" } })).toThrow();
  expect(() => prices.save({ ...input, rates: { input: "-1", output: "1" } })).toThrow();
  expect(() => prices.save({ ...input, validUntil: "2025-01-01T00:00:00Z" })).toThrow("invalid_price_interval");
});
it("keeps expired prices visible for offline accounting while marking their actual validity", () => {
  const prices = setup(), expired = prices.save({ ...input, validUntil: "2026-02-01T00:00:00Z" });
  expect(prices.resolve(input)?.id).toBe(expired.id);
  expect(prices.resolve(input)?.validUntil).toBe("2026-02-01T00:00:00.000Z");
});

it("imports a frozen actual models.dev record through an explicit connection mapping and user prices override it", () => {
  const prices = setup();
  const mapped = prices.importBundledModelsDev({ providerConnectionId: "official", modelId: "gpt-5", catalogProviderId: "openai", baseUrl: "https://api.openai.com/v1", protocol: "responses" });
  expect(mapped).toMatchObject({ source: "verified_catalog", upstreamProvider: "openai", rates: { input: "1.25", output: "10", cacheRead: "0.125" } });
  expect(mapped.sourceVersion).toContain("cb08aee43cbb");
  expect(() => prices.importBundledModelsDev({ providerConnectionId: "proxy", modelId: "gpt-5", catalogProviderId: "openai", baseUrl: "https://proxy.invalid/v1", protocol: "responses" })).toThrow("catalog_mapping_confirmation_required");
  const custom = prices.save({ ...input, providerConnectionId: "official", baseUrl: "https://api.openai.com/v1", protocol: "responses" });
  expect(prices.resolve({ ...custom })?.id).toBe(custom.id);
  const priority = prices.importBundledModelsDev({ providerConnectionId: "official", modelId: "gpt-5", catalogProviderId: "openai", baseUrl: "https://api.openai.com/v1", protocol: "responses", serviceTier: "priority" });
  expect(priority.rates.input).toBe("2.5");
  expect(() => prices.importBundledModelsDev({ providerConnectionId: "official", modelId: "gpt-5", catalogProviderId: "openai", baseUrl: "https://api.openai.com/v1", protocol: "responses", serviceTier: "unrecognized" })).toThrow("catalog_service_tier_unknown");
});
