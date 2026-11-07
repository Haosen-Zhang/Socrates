import type { TokenUsage } from "./chat";

/** Shared by quotes, dispatch and the composer; reasoning also consumes this cap. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
export const MAX_AUTOMATIC_OUTPUT_TOKENS = 32_768;

/** Ledger precision is fixed; every amount crosses JSON as an integer string. */
export const MONEY_SCALE = 12 as const;
const FACTOR = 1_000_000_000_000n;
export interface Money { currency: string; atomic: string; scale: typeof MONEY_SCALE }
export type BudgetMode = "strict_admission" | "soft_limit" | "tracking_only";
export type CostStatus = "priced" | "partially_priced" | "estimated" | "outcome_unknown" | "unpriced";
export type InvocationPurpose = "respond" | "classify" | "plan" | "execute" | "review" | "compact" | "memory" | "summarize" | "arena_evaluate";
export interface InvocationIdentity {
  invocationId: string; logicalStepId: string; attemptNo: number; roomId: string; rootTaskId: string; runId: string;
  workPackageId?: string; agentId: string; purpose: InvocationPurpose; providerConnectionId: string; modelId: string;
  runProfileVersion: string; traceId: string; spanId: string;
}
/** Decimal currency units per one million tokens, never binary floats. */
export interface TokenRates { input: string; output: string; cacheRead?: string; cacheWrite?: string }
export interface UsageSemantics { inputIncludesCacheRead: boolean; inputIncludesCacheWrite: boolean; outputIncludesReasoning: boolean }
export interface PriceInput {
  providerConnectionId: string; upstreamProvider?: string; modelId: string; protocol: string; baseUrl: string; serviceTier?: string;
  currency: string; rates: TokenRates; source: "user_confirmed" | "official" | "verified_catalog" | "preset_estimate";
  estimateReason?: string;
  sourceUrl?: string; sourceVersion: string; fetchedAt?: string; validFrom?: string; validUntil?: string | null;
  billingMode?: "metered" | "subscription" | "local" | "unknown"; explicitlyFree?: boolean;
  usageSemantics?: UsageSemantics; unsupportedDimensions?: string[]; tiers?: Array<{ minInputTokens: number; rates: TokenRates }>;
}
export interface PriceSnapshot extends Omit<PriceInput, "upstreamProvider" | "serviceTier" | "fetchedAt" | "validFrom" | "validUntil" | "sourceUrl" | "billingMode" | "explicitlyFree" | "usageSemantics" | "unsupportedDimensions" | "tiers"> {
  id: string; upstreamProvider: string; serviceTier: string; contentHash: string; fetchedAt: string; validFrom: string;
  validUntil: string | null; sourceUrl: string; billingMode: "metered" | "subscription" | "local" | "unknown";
  explicitlyFree: boolean; usageSemantics: UsageSemantics; unsupportedDimensions: string[]; tiers: Array<{ minInputTokens: number; rates: TokenRates }>;
}
export interface CostLineItem { kind: "input" | "cache_read" | "cache_write" | "output"; quantity: number; ratePerMillion: string; amount: Money }
export interface PricedUsage { status: CostStatus; amount: Money | null; lineItems: CostLineItem[]; unknownItems: string[]; adapterVersion: string }
export interface InvocationRecord extends InvocationIdentity, PricedUsage {
  referenceEstimate?: { amount: Money; priceSnapshotId: string; source: PriceInput["source"]; reason: string };
  priceSnapshotId: string | null; state: "created" | "sent" | "finished" | "outcome_unknown" | "not_sent";
  usage: TokenUsage | null; requestId: string | null; finishReason: string | null; outcome: string | null;
  createdAt: string; updatedAt: string;
  reconciliation?: { amount: Money; requestId: string; reason: string };
}
export interface CostSummary {
  invocations: number; unknownCount: number; totals: Money[]; byAgent: Array<{ agentId: string; invocations: number; unknownCount: number; totals: Money[]; estimatedTotals?: Money[]; outcomeUnknownCount?: number; unpricedCount?: number; partialCount?: number }>;
  estimatedTotals?: Money[]; estimatedCount?: number; outcomeUnknownCount?: number; unpricedCount?: number; partialCount?: number;
  usage: TokenUsage; historicalUnknownCount: number;
}
export interface BudgetAccount { rootTaskId: string; roomId: string; mode: BudgetMode; limitAtomic: string; parentId: string | null; revision: number }
export interface BudgetSummary extends BudgetAccount {
  estimatedAtomic?: string;
  settledKnownAtomic: string; activeReservationsAtomic: string; unresolvedExposureAtomic: string; availableAtomic: string;
  unknownCount: number; breached: boolean; blockedReason: string | null;
}

export function decimalToAtomic(value: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(value)) throw new Error("invalid_money_decimal");
  const [whole, fraction = ""] = value.split(".");
  return (BigInt(whole!) * FACTOR + BigInt(fraction.padEnd(MONEY_SCALE, "0"))).toString();
}
export function atomicToDecimal(value: string): string {
  const amount = atomic(value, true), sign = amount < 0n ? "-" : "", abs = amount < 0n ? -amount : amount;
  const fraction = (abs % FACTOR).toString().padStart(MONEY_SCALE, "0").replace(/0+$/, "");
  return `${sign}${abs / FACTOR}${fraction ? `.${fraction}` : ""}`;
}
export function atomic(value: string, allowNegative = false): bigint {
  if (typeof value !== "string" || !(allowNegative ? /^-?(0|[1-9]\d*)$/ : /^(0|[1-9]\d*)$/).test(value)) throw new Error("invalid_money_atomic");
  return BigInt(value);
}
export function money(value: string | bigint, currency = "USD"): Money { return { currency, atomic: typeof value === "bigint" ? value.toString() : atomic(value, true).toString(), scale: MONEY_SCALE }; }
const quantity = (value: number | undefined): value is number => Number.isSafeInteger(value) && value! >= 0;
const ceilDiv = (n: bigint, denominator: bigint) => (n + denominator - 1n) / denominator;
function ratesFor(price: PriceSnapshot, input: number): TokenRates {
  return [...price.tiers].sort((a, b) => b.minInputTokens - a.minInputTokens).find(tier => input >= tier.minInputTokens)?.rates ?? price.rates;
}
/** Canonical AI SDK totals include cache/reasoning. Raw provider fixtures can declare other semantics explicitly. */
export function priceUsage(usage: TokenUsage | undefined | null, price: PriceSnapshot | null): PricedUsage {
  const base = { amount: null, lineItems: [] as CostLineItem[], unknownItems: [] as string[], adapterVersion: "text_tokens/1" };
  if (!usage) return { ...base, status: "outcome_unknown", unknownItems: ["provider_usage_missing"] };
  if (!price) return { ...base, status: "unpriced", unknownItems: ["price_unknown", ...(usage.unsupportedBillingDimensions ?? [])] };
  if (price.unsupportedDimensions.length || price.billingMode === "unknown") return { ...base, status: "unpriced", unknownItems: [...price.unsupportedDimensions, ...(price.billingMode === "unknown" ? ["billing_mode_unknown"] : [])] };
  const unknown = base.unknownItems, lines = base.lineItems;
  const dimensions = (usage.unsupportedBillingDimensions ?? []).filter(value => !value.startsWith("openai_service_tier:") || value.slice("openai_service_tier:".length) !== price.serviceTier);
  unknown.push(...dimensions);
  if (dimensions.some(value => value.startsWith("openai_service_tier:"))) return { ...base, status: "partially_priced", unknownItems: dimensions };
  const rates = ratesFor(price, quantity(usage.inputTokens) ? usage.inputTokens : 0);
  const separateMissingRead = usage.cachedInputTokens === undefined && rates.cacheRead !== undefined
    && (decimalToAtomic(rates.cacheRead) !== decimalToAtomic(rates.input) || !price.usageSemantics.inputIncludesCacheRead);
  const separateMissingWrite = usage.cacheWriteTokens === undefined && rates.cacheWrite !== undefined
    && (decimalToAtomic(rates.cacheWrite) !== decimalToAtomic(rates.input) || !price.usageSemantics.inputIncludesCacheWrite);
  const read = separateMissingRead ? undefined : usage.cachedInputTokens ?? 0;
  const write = separateMissingWrite ? undefined : usage.cacheWriteTokens ?? 0;
  const reasoning = usage.reasoningTokens ?? 0;
  const add = (kind: CostLineItem["kind"], count: number | undefined, rate: string | undefined) => {
    if (!quantity(count)) { unknown.push(`${kind}_quantity`); return; }
    if (!count) return;
    if (kind === "cache_write" && dimensions.includes("openai_cache_write_12h")) { unknown.push("cache_write_rate_rule"); return; }
    if (rate === undefined) { unknown.push(kind); return; }
    const rateAtomic = BigInt(decimalToAtomic(rate));
    lines.push({ kind, quantity: count, ratePerMillion: rate, amount: money(ceilDiv(BigInt(count) * rateAtomic, 1_000_000n), price.currency) });
  };
  let uncached: number | undefined;
  if (quantity(usage.inputTokens) && (!price.usageSemantics.inputIncludesCacheRead || quantity(read)) && (!price.usageSemantics.inputIncludesCacheWrite || quantity(write))) {
    uncached = usage.inputTokens - (price.usageSemantics.inputIncludesCacheRead ? read! : 0) - (price.usageSemantics.inputIncludesCacheWrite ? write! : 0);
  }
  add("input", uncached, rates.input); add("cache_read", read, rates.cacheRead); add("cache_write", write, rates.cacheWrite);
  const output = quantity(usage.outputTokens) && quantity(reasoning)
    ? usage.outputTokens + (price.usageSemantics.outputIncludesReasoning ? 0 : reasoning) : undefined;
  if (price.usageSemantics.outputIncludesReasoning && quantity(usage.outputTokens) && reasoning > usage.outputTokens) unknown.push("reasoning_exceeds_output");
  add("output", output, rates.output);
  const amount = lines.length || !unknown.length ? money(lines.reduce((sum, item) => sum + BigInt(item.amount.atomic), 0n), price.currency) : null;
  return { ...base, status: unknown.length ? "partially_priced" : price.estimateReason || price.source === "preset_estimate" ? "estimated" : "priced", amount };
}

/** Caller must separately prove that the input token count and executable output cap are upper bounds. */
export function requestCostUpperBound(price: PriceSnapshot | null, inputTokens: number, outputTokens: number): Money | null {
  if (!price || !quantity(inputTokens) || !quantity(outputTokens) || !price.usageSemantics.outputIncludesReasoning || !price.usageSemantics.inputIncludesCacheRead || !price.usageSemantics.inputIncludesCacheWrite || price.unsupportedDimensions.length || price.billingMode === "unknown") return null;
  const options = [price.rates, ...price.tiers.map(tier => tier.rates)];
  const max = (values: Array<string | undefined>) => values.reduce<bigint>((highest, value) => value === undefined ? highest : BigInt(decimalToAtomic(value)) > highest ? BigInt(decimalToAtomic(value)) : highest, 0n);
  const worstInput = max(options.flatMap(rates => [rates.input, rates.cacheRead, rates.cacheWrite]));
  const worstOutput = max(options.map(rates => rates.output));
  return money(ceilDiv(BigInt(inputTokens) * worstInput + BigInt(outputTokens) * worstOutput, 1_000_000n), price.currency);
}
