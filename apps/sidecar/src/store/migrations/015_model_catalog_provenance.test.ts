import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../migrations";
import { migrations } from "./index";

describe("015 model catalog provenance migration", () => {
  it("treats legacy numeric limits as user overrides and unknown as unavailable", () => {
    const db = new Database(":memory:");
    runMigrations(db, migrations.slice(0, 14));
    const now = new Date().toISOString();
    const insert = db.query(`INSERT INTO agents
      (id, display_name, provider_id, model_id, role, system_prompt, model_capabilities_json, created_at, updated_at)
      VALUES (?, ?, 'provider', 'model', '', '', ?, ?, ?)`);
    db.query(`INSERT INTO providers
      (id, name, type, base_url, api_key_ref, enabled, created_at, updated_at)
      VALUES ('provider', 'Provider', 'openai_compatible', 'https://example.test/v1', 'ref', 1, ?, ?)`).run(now, now);
    insert.run("numeric", "Numeric", JSON.stringify({ contextWindowTokens: 128_000 }), now, now);
    insert.run("unknown", "Unknown", JSON.stringify({ contextWindowTokens: "unknown" }), now, now);

    expect(runMigrations(db, migrations)).toEqual([15]);
    const rows = db.query<{ id: string; model_capabilities_json: string }, []>(
      "SELECT id, model_capabilities_json FROM agents ORDER BY id",
    ).all();
    const numeric = JSON.parse(rows.find((row) => row.id === "numeric")!.model_capabilities_json);
    const unknown = JSON.parse(rows.find((row) => row.id === "unknown")!.model_capabilities_json);
    expect(numeric.contextWindow).toMatchObject({ catalogValue: null, userOverride: 128_000, effectiveValue: 128_000, source: "user_override" });
    expect(unknown.contextWindow).toMatchObject({ catalogValue: null, userOverride: null, effectiveValue: null, source: "unavailable" });
  });
});
