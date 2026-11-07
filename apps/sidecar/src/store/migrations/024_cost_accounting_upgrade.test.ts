import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../../db";
import { runMigrations } from "../migrations";
import { migrations } from "./index";
import { SessionStore } from "../session-store";
import { PricingStore } from "../../services/pricing-store";
import { CostLedger } from "../../services/cost-ledger";
import { normalizeTokenUsage, UsageCollector } from "../../services/usage-collector";

const EARLY_CHECKSUM = "c31ffcef6816265e8f707e3ce5625c3add8169b6b1ac2a92531f492814d738ff";
const COMPLETE_CHECKSUM = "04bbe3e3613092a0bf97050050f0fc3677b3cc05d1834851830c947946b08e7d";

test("a previously applied early 023 upgrades without changing its checksum, messages, usage or incurred costs", () => {
  const directory = mkdtempSync(join(tmpdir(), "socrates-applied-023-")), path = join(directory, "fixture.db");
  let db = new Database(path);
  try {
    runMigrations(db, migrations.filter(m => m.version <= 22));
    const room = new SessionStore(db).create({ title: "Preserved", mode: "chat", primaryAgentId: "a", agents: [{ agentId: "a", snapshot: {}, executionEligible: true }] });
    db.query("INSERT INTO session_messages(id,session_id,role,content,status,created_at) VALUES ('preserved',?,'user','Original history','completed','now')").run(room.id);
    new UsageCollector(db).record({ stableKey: "legacy-usage", sessionId: room.id, taskId: "old-task", usage: normalizeTokenUsage({ inputTokens: 10, outputTokens: 5 }) });
    db.exec(readFileSync(new URL("./fixtures/023_early_cost_schema.sql", import.meta.url), "utf8"));
    db.query("INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (23,'cost_invocations_prices_budgets',?,'2026-11-06T00:00:00Z')").run(EARLY_CHECKSUM);
    const price = new PricingStore(db).save({ providerConnectionId: "p", modelId: "fixture", protocol: "openai_chat_completions", baseUrl: "https://fixture.invalid/v1", currency: "USD", rates: { input: "1", output: "1" }, source: "user_confirmed", sourceVersion: "fixture/1" });
    const identity = { invocationId: "old-invocation", logicalStepId: "step", attemptNo: 1, roomId: room.id, rootTaskId: "old-task", runId: "old-run", agentId: "a", purpose: "respond", providerConnectionId: "p", modelId: "fixture", runProfileVersion: "1", traceId: "trace", spanId: "span" };
    db.query(`INSERT INTO cost_invocations(id,logical_step_id,attempt_no,room_id,root_task_id,run_id,agent_id,identity_json,price_snapshot_id,state,status,adapter_version,currency,amount_atomic,created_at,updated_at)
      VALUES ('old-invocation','step',1,?,'old-task','old-run','a',?,?,'finished','priced','text_tokens/1','USD','120000000','now','now')`).run(room.id, JSON.stringify(identity), price.id);
    db.query("INSERT INTO cost_adjustments(id,invocation_id,request_id,amount_atomic,currency,reason,created_at) VALUES ('old-adjustment','old-invocation','invoice','20000000','USD','Confirmed delta','now')").run();
    db.close(); db = openDb(path);
    expect(db.query("SELECT checksum FROM schema_migrations WHERE version=23").get()).toEqual({ checksum: EARLY_CHECKSUM });
    expect(db.query("SELECT version FROM schema_migrations WHERE version=24").get()).toEqual({ version: 24 });
    expect(db.query("SELECT content FROM session_messages WHERE id='preserved'").get()).toEqual({ content: "Original history" });
    expect(new UsageCollector(db).sessionSummaries(room.id)[0]!.cumulative.totalTokens).toBe(15);
    expect(new CostLedger(db).summary({ roomId: room.id })).toMatchObject({ totals: [{ currency: "USD", atomic: "140000000", scale: 12 }], historicalUnknownCount: 1 });
    expect(db.query("SELECT name FROM sqlite_master WHERE name='cost_actions'").get()).not.toBeNull();
    expect(db.query("SELECT actual_total_atomic FROM cost_adjustments WHERE id='old-adjustment'").get()).toEqual({ actual_total_atomic: null });
    expect(readdirSync(directory).some(name => name.startsWith("fixture.db.backup-"))).toBe(true);
    db.close(); db = openDb(path);
    expect(db.query("SELECT COUNT(*) AS count FROM cost_legacy_usage").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=24").get()).toEqual({ count: 1 });
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("known complete 023 remains supported without rewriting its applied checksum; unknown drift is still refused", () => {
  const db = openDb(":memory:");
  try {
    db.query("DELETE FROM schema_migrations WHERE version=24").run();
    const room = new SessionStore(db).create({ title: "New observation", mode: "chat", primaryAgentId: "a", agents: [{ agentId: "a", snapshot: {}, executionEligible: true }] });
    new UsageCollector(db).record({ stableKey: "after-complete-023", sessionId: room.id, usage: normalizeTokenUsage({ inputTokens: 1, outputTokens: 2 }) });
    db.query("UPDATE schema_migrations SET checksum=? WHERE version=23").run(COMPLETE_CHECKSUM);
    expect(() => runMigrations(db, migrations)).not.toThrow();
    expect(db.query("SELECT checksum FROM schema_migrations WHERE version=23").get()).toEqual({ checksum: COMPLETE_CHECKSUM });
    expect(db.query("SELECT version FROM schema_migrations WHERE version=24").get()).toEqual({ version: 24 });
    expect(db.query("SELECT COUNT(*) AS count FROM cost_legacy_usage").get()).toEqual({ count: 0 });
    db.query("UPDATE schema_migrations SET checksum=? WHERE version=23").run("f".repeat(64));
    expect(() => runMigrations(db, migrations)).toThrow("migration_checksum_mismatch:23");
  } finally { db.close(); }
});

test("a claimed complete 023 with missing required schema is not accepted as a compatible checksum", () => {
  const db = openDb(":memory:");
  try {
    db.query("UPDATE schema_migrations SET checksum=? WHERE version=23").run(COMPLETE_CHECKSUM);
    db.exec("DROP TABLE cost_actions");
    expect(() => runMigrations(db, migrations)).toThrow("migration_checksum_mismatch:23");
  } finally { db.close(); }
});
