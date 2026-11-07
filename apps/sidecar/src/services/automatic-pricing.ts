import { atomicToDecimal, decimalToAtomic, type PriceInput, type TokenRates } from "@socrates/core";
import type { PriceIdentity } from "./pricing-store";

// Public billing facts verified 2026-11-07. No credentials or inference request.
const fetchedAt = "2026-11-07T10:13:08.000Z";
const expiresAt = "2026-12-07T00:00:00.000Z";
const openai: Record<string, TokenRates> = {
  "gpt-6-astra": { input: "10", output: "50", cacheRead: "1", cacheWrite: "12.5" },
  "gpt-6.1-sol": { input: "2", output: "10", cacheRead: "0.1", cacheWrite: "2.5" },
  "gpt-6.1-terra": { input: "1", output: "5", cacheRead: "0.05", cacheWrite: "1.25" },
  "gpt-6-luna": { input: "0.1", output: "0.5", cacheRead: "0.01", cacheWrite: "0.125" },
  "gpt-5.6-luna": { input: "0.2", output: "1.2", cacheRead: "0.02", cacheWrite: "0.25" },
};
const scaled = (value: string, numerator: bigint, denominator = 1n) => atomicToDecimal((BigInt(decimalToAtomic(value)) * numerator / denominator).toString());
const multiply = (rates: TokenRates): TokenRates => ({ input: scaled(rates.input, 2n), output: scaled(rates.output, 3n, 2n),
  ...(rates.cacheRead ? { cacheRead: scaled(rates.cacheRead, 2n) } : {}), ...(rates.cacheWrite ? { cacheWrite: scaled(rates.cacheWrite, 2n) } : {}) });

export function automaticPrice(identity: PriceIdentity, at: string): PriceInput {
  const time = new Date(at), url = new URL(identity.baseUrl), tier = identity.serviceTier ?? "default";
  const endpoint = url.toString().replace(/\/+$/, "");
  const rates = openai[identity.modelId];
  const base = { ...identity, currency: "USD", fetchedAt, validFrom: fetchedAt, validUntil: expiresAt,
    sourceVersion: "bundled-public-prices/2026-11-07", estimateReason: "official_reference" };
  if (rates && tier === "default" && endpoint === "https://api.openai.com/v1" && identity.protocol === "openai_responses") {
    return { ...base, rates, source: "official", upstreamProvider: "openai",
      sourceUrl: `https://developers.openai.com/api/docs/models/${identity.modelId}`,
      tiers: [{ minInputTokens: 272001, rates: multiply(rates) }] };
  }
  const flash = ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].includes(identity.modelId);
  const pro = identity.modelId === "deepseek-v4-pro";
  const deepseekEndpoint = identity.protocol === "openai_chat_completions" && ["https://api.deepseek.com", "https://api.deepseek.com/v1"].includes(endpoint)
    || identity.protocol === "anthropic_messages" && endpoint === "https://api.deepseek.com/anthropic";
  if ((flash || pro) && deepseekEndpoint && tier === "default") {
    const day = Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate());
    const hour = time.getUTCHours(), weekday = time.getUTCDay() > 0 && time.getUTCDay() < 6;
    const boundaries = weekday ? [0, 1, 4, 6, 10, 24] : [0, 24];
    const start = boundaries.filter(value => value <= hour).at(-1)!;
    const end = boundaries.find(value => value > hour)!;
    // Peak reference is an upper estimate on Chinese public holidays. Never
    // claim an unverified holiday calendar is exact invoice evidence.
    const peak = weekday && (hour >= 1 && hour < 4 || hour >= 6 && hour < 10);
    const chosen: TokenRates = pro
      ? peak ? { input: "1.32", output: "3.96", cacheRead: "0.044" } : { input: "0.66", output: "1.98", cacheRead: "0.022" }
      : peak ? { input: "0.3", output: "1.2", cacheRead: "0.006" } : { input: "0.15", output: "0.6", cacheRead: "0.003" };
    return { ...base, rates: chosen, source: "official", upstreamProvider: "deepseek", sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing/",
      estimateReason: peak ? "official_peak_reference" : "official_reference",
      sourceVersion: `${base.sourceVersion}:deepseek:${day}:${start}`, validFrom: new Date(Math.max(Date.parse(fetchedAt), day + start * 3600000)).toISOString(),
      validUntil: new Date(day + end * 3600000).toISOString() };
  }
  // A usable starting estimate, not a claimed tariff for a namesake proxy.
  return { ...base, source: "preset_estimate", upstreamProvider: "unverified", estimateReason: rates ? "proxy_reference_estimate" : "generic_price_estimate",
    rates: rates ?? { input: "1", output: "5", cacheRead: "1", cacheWrite: "1" },
    sourceUrl: rates ? `https://developers.openai.com/api/docs/models/${identity.modelId}` : "local:editable-price-preset" };
}
