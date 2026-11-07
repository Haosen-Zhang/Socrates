import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { decimalToAtomic, type PriceInput, type PriceSnapshot } from "@socrates/core";
import { automaticPrice } from "./automatic-pricing";

const decimal = z.string().refine(value => { try { decimalToAtomic(value); return true; } catch { return false; } }, "invalid rate");
const rates = z.object({ input: decimal, output: decimal, cacheRead: decimal.optional(), cacheWrite: decimal.optional() });
const schema = z.object({
  providerConnectionId: z.string().min(1).max(200), upstreamProvider: z.string().max(200).optional(), modelId: z.string().min(1).max(300), protocol: z.string().min(1).max(100),
  baseUrl: z.string().url(), serviceTier: z.string().min(1).max(100).optional(), currency: z.string().regex(/^[A-Z]{3,8}$/), rates,
  source: z.enum(["user_confirmed", "official", "verified_catalog", "preset_estimate"]), estimateReason: z.string().max(200).optional(), sourceUrl: z.string().max(2000).optional(), sourceVersion: z.string().min(1).max(300),
  fetchedAt: z.string().optional(), validFrom: z.string().optional(), validUntil: z.string().nullable().optional(),
  billingMode: z.enum(["metered", "subscription", "local", "unknown"]).optional(), explicitlyFree: z.boolean().optional(),
  usageSemantics: z.object({ inputIncludesCacheRead: z.boolean(), inputIncludesCacheWrite: z.boolean(), outputIncludesReasoning: z.boolean() }).optional(),
  unsupportedDimensions: z.array(z.string().max(100)).max(50).optional(),
  tiers: z.array(z.object({ minInputTokens: z.number().int().nonnegative(), rates })).max(30).optional(),
});
export interface PriceIdentity { providerConnectionId: string; modelId: string; protocol: string; baseUrl: string; serviceTier?: string }
export interface CatalogMapping extends PriceIdentity { catalogProviderId: string; catalogModelId?: string; confirmedMapping?: boolean }
const catalogCost = z.object({ input: z.number().finite().nonnegative(), output: z.number().finite().nonnegative(), cache_read: z.number().finite().nonnegative().optional(), cache_write: z.number().finite().nonnegative().optional() }).passthrough();
const catalogModel = z.object({ id: z.string(), cost: catalogCost, experimental: z.object({ modes: z.record(z.string(), z.object({ cost: catalogCost, provider: z.object({ body: z.object({ service_tier: z.string() }).passthrough() }).passthrough() }).passthrough()) }).passthrough().optional() }).passthrough();
const catalogSchema = z.record(z.string(), z.object({ id: z.string(), models: z.record(z.string(), catalogModel) }).passthrough());
const priority = { user_confirmed: 3, official: 2, verified_catalog: 1, preset_estimate: 0 };
export function normalizePriceEndpoint(raw: string): string {
  const url = new URL(raw);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("invalid_price_endpoint");
  if (url.username || url.password || url.search || url.hash) throw new Error("price_endpoint_credentials_forbidden");
  return url.toString().replace(/\/+$/, "");
}
function iso(value: string): string { const timestamp = Date.parse(value); if (!Number.isFinite(timestamp)) throw new Error("invalid_price_date"); return new Date(timestamp).toISOString(); }

export class PricingStore {
  constructor(private readonly db: Database) {}
  save(raw: PriceInput): PriceSnapshot {
    const input = schema.parse(raw), now = new Date().toISOString();
    const allRates = [input.rates, ...(input.tiers ?? []).map(tier => tier.rates)].flatMap(rate => Object.values(rate));
    if (allRates.every(rate => BigInt(decimalToAtomic(rate)) === 0n) && !input.explicitlyFree) throw new Error("free_price_requires_confirmation");
    if (input.source === "verified_catalog" && allRates.some(rate => BigInt(decimalToAtomic(rate)) === 0n) && !input.explicitlyFree) throw new Error("catalog_zero_rate_requires_confirmation");
    const validFrom = iso(input.validFrom ?? now), validUntil = input.validUntil ? iso(input.validUntil) : null;
    if (validUntil && validUntil <= validFrom) throw new Error("invalid_price_interval");
    const content: Omit<PriceSnapshot, "id" | "contentHash"> = {
      ...input, upstreamProvider: input.upstreamProvider ?? "custom", baseUrl: normalizePriceEndpoint(input.baseUrl),
      serviceTier: input.serviceTier ?? "default", fetchedAt: iso(input.fetchedAt ?? now), validFrom, validUntil,
      sourceUrl: input.sourceUrl ?? "local:user", billingMode: input.billingMode ?? "metered", explicitlyFree: input.explicitlyFree ?? false,
      usageSemantics: input.usageSemantics ?? { inputIncludesCacheRead: true, inputIncludesCacheWrite: true, outputIncludesReasoning: true },
      unsupportedDimensions: input.unsupportedDimensions ?? [], tiers: input.tiers ?? [],
    };
    const contentHash = createHash("sha256").update(JSON.stringify(content)).digest("hex"), id = `price:${contentHash}`;
    const snapshot: PriceSnapshot = { ...content, id, contentHash };
    this.db.query(`INSERT OR IGNORE INTO cost_price_snapshots(id,provider_id,model_id,protocol,base_url,service_tier,source,content_hash,snapshot_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, snapshot.providerConnectionId, snapshot.modelId, snapshot.protocol, snapshot.baseUrl, snapshot.serviceTier, snapshot.source, contentHash, JSON.stringify(snapshot), now);
    return this.get(id)!;
  }
  get(id: string): PriceSnapshot | null { const row = this.db.query<{ snapshot_json: string }, [string]>("SELECT snapshot_json FROM cost_price_snapshots WHERE id=?").get(id); return row ? JSON.parse(row.snapshot_json) as PriceSnapshot : null; }
  list(providerConnectionId?: string): PriceSnapshot[] {
    return (providerConnectionId
      ? this.db.query<{ snapshot_json: string }, [string]>("SELECT snapshot_json FROM cost_price_snapshots WHERE provider_id=? ORDER BY rowid DESC").all(providerConnectionId)
      : this.db.query<{ snapshot_json: string }, []>("SELECT snapshot_json FROM cost_price_snapshots ORDER BY rowid DESC").all()).map(row => JSON.parse(row.snapshot_json) as PriceSnapshot);
  }
  conflicts(identity: PriceIdentity): PriceSnapshot[] {
    const endpoint = normalizePriceEndpoint(identity.baseUrl);
    return this.list(identity.providerConnectionId).filter(price => price.modelId === identity.modelId && price.baseUrl === endpoint && price.protocol === identity.protocol && price.serviceTier === (identity.serviceTier ?? "default"));
  }
  resolve(identity: PriceIdentity, at = new Date().toISOString()): PriceSnapshot | null {
    const time = iso(at), candidates = this.conflicts(identity).filter(price => price.validFrom <= time);
    const current = candidates.filter(price => !price.validUntil || price.validUntil > time);
    // An expired offline snapshot stays visibly expired. Admission must reject
    // it as a strict bound; recorded calls keep their historical snapshot.
    return (current.length ? current : candidates).sort((a, b) => priority[b.source] - priority[a.source] || b.fetchedAt.localeCompare(a.fetchedAt))[0] ?? null;
  }
  resolveAutomatic(identity: PriceIdentity, at = new Date().toISOString()): PriceSnapshot {
    const normalized = { ...identity, baseUrl: normalizePriceEndpoint(identity.baseUrl) };
    const prior = this.resolve(normalized, at);
    if (prior?.source === "user_confirmed") return prior;
    const automatic = automaticPrice(normalized, at);
    if (prior && prior.source !== "preset_estimate" && (automatic.source === "preset_estimate" || prior.fetchedAt > automatic.fetchedAt!)) return prior;
    return this.save(automatic);
  }
  /** Offline data reuse, with no name-only inference for proxies. */
  importBundledModelsDev(mapping: CatalogMapping): PriceSnapshot {
    const bytes = readFileSync(new URL("./fixtures/models-dev-frozen.json", import.meta.url));
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== "cb08aee43cbb553063a1e5311447a262837b74eb54f5ed184909f581467e9b76") throw new Error("catalog_fixture_integrity_failed");
    return this.importModelsDev(JSON.parse(bytes.toString("utf8")), mapping, { version: `models.dev:${hash}`, fetchedAt: "2026-11-06T00:00:00.000Z", sourceUrl: "https://models.dev/api.json" });
  }
  importModelsDev(raw: unknown, mapping: CatalogMapping, provenance: { version: string; fetchedAt: string; sourceUrl: string }): PriceSnapshot {
    const catalog = catalogSchema.parse(raw), provider = catalog[mapping.catalogProviderId], model = provider?.models[mapping.catalogModelId ?? mapping.modelId];
    if (!model) throw new Error("catalog_model_unknown");
    const official: Record<string, string> = { openai: "https://api.openai.com/v1", anthropic: "https://api.anthropic.com" };
    if (!mapping.confirmedMapping && normalizePriceEndpoint(mapping.baseUrl) !== official[mapping.catalogProviderId]) throw new Error("catalog_mapping_confirmation_required");
    const tier = mapping.serviceTier ?? "default";
    const cost = tier === "default" ? model.cost : Object.values(model.experimental?.modes ?? {}).find(mode => mode.provider.body.service_tier === tier)?.cost;
    if (!cost) throw new Error("catalog_service_tier_unknown");
    // Future/unrecognized rate dimensions stay explicit and cannot be given
    // a text-only strict bound. Unknown model metadata is retained upstream.
    const unsupportedDimensions = Object.keys(cost).filter(key => !["input", "output", "cache_read", "cache_write"].includes(key));
    return this.save({ providerConnectionId: mapping.providerConnectionId, upstreamProvider: mapping.catalogProviderId, modelId: mapping.modelId,
      protocol: mapping.protocol, baseUrl: mapping.baseUrl, serviceTier: tier, currency: "USD", rates: { input: String(cost.input), output: String(cost.output),
        ...(cost.cache_read !== undefined ? { cacheRead: String(cost.cache_read) } : {}), ...(cost.cache_write !== undefined ? { cacheWrite: String(cost.cache_write) } : {}) },
      source: "verified_catalog", sourceVersion: provenance.version, sourceUrl: provenance.sourceUrl, fetchedAt: provenance.fetchedAt,
      validFrom: provenance.fetchedAt, billingMode: "metered", unsupportedDimensions });
  }
}
