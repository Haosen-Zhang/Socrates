import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveContextWindow, type ContextWindowResolution } from "@socrates/core";
import type { FetchLike } from "./providers";

type CatalogModel = { limit?: { context?: unknown } };
type CatalogProvider = { id?: string; api?: string; models?: Record<string, CatalogModel> };
type CatalogDocument = Record<string, CatalogProvider>;
type CacheEnvelope = { sha256: string; etag: string | null; fetchedAt: string; revision: string; document: CatalogDocument };

export type CatalogProviderInput = { baseUrl: string; catalogProviderId?: string | null };

export class ModelCatalog {
  private cache: CacheEnvelope | null = null;
  private refreshPromise: Promise<void> | null = null;
  private readonly refreshIntervalMs = 24 * 60 * 60 * 1000;

  constructor(
    private readonly dataDir: string,
    private readonly fetchFn: FetchLike = fetch,
    private readonly url = process.env.SOCRATES_MODEL_CATALOG_URL ?? "https://models.opencode.ai/api.json",
  ) {
    this.cache = this.readCache();
  }

  async resolve(provider: CatalogProviderInput, modelId: string, userOverride: number | null): Promise<ContextWindowResolution> {
    await this.refresh();
    const now = new Date().toISOString();
    const match = this.matchProvider(provider);
    const raw = match?.provider.models?.[modelId]?.limit?.context;
    const catalogValue = Number.isSafeInteger(raw) && Number(raw) >= 1_024 && Number(raw) <= 4_000_000
      ? Number(raw)
      : null;
    return resolveContextWindow(catalogValue, userOverride, {
      catalogProviderId: match?.id ?? null,
      catalogRevision: this.cache?.revision ?? null,
      resolvedAt: now,
    });
  }

  private async refresh(): Promise<void> {
    if (this.cache && Date.now() - Date.parse(this.cache.fetchedAt) < this.refreshIntervalMs) return;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.fetchAndCache().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  private async fetchAndCache(): Promise<void> {
    try {
      const headers: Record<string, string> = {};
      if (this.cache?.etag) headers["If-None-Match"] = this.cache.etag;
      const response = await this.fetchFn(this.url, { headers, signal: AbortSignal.timeout(10_000) });
      if (response.status === 304 && this.cache) return;
      if (!response.ok) return;
      const text = await response.text();
      const document = JSON.parse(text) as CatalogDocument;
      if (!document || Array.isArray(document) || typeof document !== "object") return;
      const sha256 = documentHash(document);
      const envelope: CacheEnvelope = {
        sha256,
        etag: response.headers.get("etag"),
        fetchedAt: new Date().toISOString(),
        revision: sha256,
        document,
      };
      this.writeCache(envelope);
      this.cache = envelope;
    } catch {
      // A verified stale cache remains usable; without one resolution is unavailable.
    }
  }

  private matchProvider(input: CatalogProviderInput): { id: string; provider: CatalogProvider } | null {
    if (!this.cache) return null;
    if (input.catalogProviderId) {
      const provider = this.cache.document[input.catalogProviderId];
      return provider ? { id: input.catalogProviderId, provider } : null;
    }
    const target = normalizeApi(input.baseUrl);
    const matches = Object.entries(this.cache.document).filter(([, provider]) =>
      typeof provider.api === "string" && normalizeApi(provider.api) === target,
    );
    return matches.length === 1 ? { id: matches[0]![0], provider: matches[0]![1] } : null;
  }

  private cachePath(): string { return join(this.dataDir, "model-catalog.json"); }

  private readCache(): CacheEnvelope | null {
    try {
      const path = this.cachePath();
      if (!existsSync(path)) return null;
      const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheEnvelope;
      const sha = documentHash(parsed.document);
      return sha === parsed.sha256 ? parsed : null;
    } catch { return null; }
  }

  private writeCache(envelope: CacheEnvelope): void {
    const path = this.cachePath();
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(envelope));
    renameSync(temp, path);
  }
}

function normalizeApi(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/u, "");
}

function documentHash(document: CatalogDocument): string {
  return createHash("sha256").update(JSON.stringify(document)).digest("hex");
}
