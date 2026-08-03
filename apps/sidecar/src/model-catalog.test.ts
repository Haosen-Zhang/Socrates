import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalog } from "./model-catalog";

const document = {
  openai: {
    id: "openai",
    models: {
      "gpt-test": { limit: { context: 128_000 } },
      "gpt-5.6-luna": { limit: { context: 1_050_000, input: 922_000, output: 128_000 } },
    },
  },
};

describe("ModelCatalog", () => {
  it("resolves an exact provider/model and preserves explicit override provenance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "socrates-catalog-"));
    try {
      const catalog = new ModelCatalog(dir, async () => new Response(JSON.stringify(document), { status: 200, headers: { etag: "rev-1" } }));
      expect(await catalog.resolve({ baseUrl: "https://api.openai.com/v1" }, "gpt-test", null)).toMatchObject({
        catalogValue: 128_000, userOverride: null, effectiveValue: 128_000, source: "catalog", catalogProviderId: "openai",
      });
      expect(await catalog.resolve({ baseUrl: "https://api.openai.com/v1" }, "gpt-test", 64_000)).toMatchObject({
        catalogValue: 128_000, userOverride: 64_000, effectiveValue: 64_000, source: "user_override",
      });
      expect(JSON.parse(readFileSync(join(dir, "model-catalog.json"), "utf8"))).toMatchObject({ etag: "rev-1" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("maps the official OpenAI origin when the catalog provider omits its api field", async () => {
    const dir = mkdtempSync(join(tmpdir(), "socrates-catalog-"));
    try {
      const catalog = new ModelCatalog(dir, async () => new Response(JSON.stringify(document)));
      expect(await catalog.resolve({ baseUrl: "https://api.openai.com/v1/" }, "gpt-5.6-luna", null)).toMatchObject({
        catalogValue: 1_050_000,
        effectiveValue: 1_050_000,
        source: "catalog",
        catalogProviderId: "openai",
      });
      expect(await catalog.resolve({ baseUrl: "https://openai-compatible.example/v1" }, "gpt-5.6-luna", null)).toMatchObject({
        catalogValue: null,
        effectiveValue: null,
        source: "unavailable",
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("returns unavailable for unknown and ambiguous providers instead of guessing by model name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "socrates-catalog-"));
    try {
      const catalog = new ModelCatalog(dir, async () => new Response(JSON.stringify({
        first: { api: "https://same.test/v1", models: { shared: { limit: { context: 99_000 } } } },
        second: { api: "https://same.test/v1", models: { shared: { limit: { context: 88_000 } } } },
      })));
      expect(await catalog.resolve({ baseUrl: "https://same.test/v1" }, "shared", null)).toMatchObject({
        catalogValue: null, effectiveValue: null, source: "unavailable", catalogProviderId: null,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("uses a verified stale cache when refresh fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "socrates-catalog-"));
    try {
      const initial = new ModelCatalog(dir, async () => new Response(JSON.stringify(document)));
      await initial.resolve({ baseUrl: "https://api.openai.com/v1" }, "gpt-test", null);
      const stale = new ModelCatalog(dir, async () => { throw new Error("offline"); });
      expect(await stale.resolve({ baseUrl: "https://api.openai.com/v1" }, "gpt-test", null)).toMatchObject({
        effectiveValue: 128_000, source: "catalog",
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
