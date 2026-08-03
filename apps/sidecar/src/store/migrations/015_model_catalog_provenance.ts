import type { ModelCapabilities } from "@socrates/core";
import { resolveContextWindow } from "@socrates/core";
import type { Migration } from "../migrations";
import { ensureColumns, migrationChecksum } from "../migrations";

export const modelCatalogProvenanceMigration: Migration = {
  version: 15,
  name: "model_catalog_provenance",
  checksum: migrationChecksum("015:model-catalog-provenance:v1:provider-mapping-agent-resolution"),
  up(db) {
    ensureColumns(db, "providers", ["catalog_provider_id TEXT"]);
    const rows = db.query<{ id: string; model_capabilities_json: string | null }, []>(
      "SELECT id, model_capabilities_json FROM agents",
    ).all();
    const update = db.query("UPDATE agents SET model_capabilities_json = ? WHERE id = ?");
    for (const row of rows) {
      let capabilities: ModelCapabilities = {} as ModelCapabilities;
      try { capabilities = row.model_capabilities_json ? JSON.parse(row.model_capabilities_json) : capabilities; } catch { /* migrate as unavailable */ }
      if (capabilities.contextWindow) continue;
      const legacy = capabilities.contextWindowTokens;
      const userOverride = typeof legacy === "number" && Number.isSafeInteger(legacy) ? legacy : null;
      const contextWindow = resolveContextWindow(null, userOverride, {
        catalogProviderId: null,
        catalogRevision: null,
        resolvedAt: new Date().toISOString(),
      });
      update.run(JSON.stringify({
        ...capabilities,
        contextWindowTokens: contextWindow.effectiveValue ?? "unknown",
        contextWindow,
      }), row.id);
    }
  },
};
