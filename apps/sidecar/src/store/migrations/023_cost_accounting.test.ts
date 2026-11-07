import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../db";
import { runMigrations } from "../migrations";
import { migrations } from "./index";
import { SessionStore } from "../session-store";
import { UsageCollector, normalizeTokenUsage } from "../../services/usage-collector";
import { CostLedger } from "../../services/cost-ledger";

test("upgrading a populated v22 database preserves room/history/token data, snapshots unknown legacy costs and is idempotent", () => {
  const directory = mkdtempSync(join(tmpdir(), "socrates-cost-migration-")), path = join(directory, "fixture.db");
  let db = new Database(path, { create: true });
  try {
    runMigrations(db, migrations.filter(migration => migration.version <= 22));
    const sessions = new SessionStore(db);
    const room = sessions.create({ mode: "chat", title: "Preserved room", primaryAgentId: "old-member", agents: [{ agentId: "old-member", snapshot: { nickname: "Original author", modelId: "old-model" }, executionEligible: true }] });
    db.query("INSERT INTO session_messages(id,session_id,role,author_id,content,status,created_at) VALUES ('old-message',?,'assistant','old-member','Preserved message','completed','2026-01-01')").run(room.id);
    new UsageCollector(db).record({ stableKey: "original-token-record", sessionId: room.id, taskId: "old-run", agentId: "old-member", usage: normalizeTokenUsage({ inputTokens: 123, outputTokens: 45 }) });
    db.close(); db = openDb(path);
    expect(new SessionStore(db).get(room.id)).toMatchObject({ id: room.id, title: "Preserved room", primaryAgentId: "old-member" });
    expect(db.query("SELECT id,content,author_id FROM session_messages WHERE id='old-message'").get()).toEqual({ id: "old-message", content: "Preserved message", author_id: "old-member" });
    expect(new UsageCollector(db).sessionSummaries(room.id)[0]!.cumulative.inputTokens).toBe(123);
    expect(new UsageCollector(db).sessionSummaries(room.id)[0]!.cumulative.outputTokens).toBe(45);
    expect(new CostLedger(db).summary({ roomId: room.id })).toMatchObject({ historicalUnknownCount: 1, invocations: 0, totals: [] });
    expect(readdirSync(directory).some(name => name.startsWith("fixture.db.backup-"))).toBe(true);
    db.query("DELETE FROM usage_records WHERE stable_key='original-token-record'").run();
    expect(new CostLedger(db).summary({ roomId: room.id }).historicalUnknownCount).toBe(1);
    db.close(); db = openDb(path);
    expect(db.query("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=23").get()).toEqual({ n: 1 });
    expect(new CostLedger(db).summary({ roomId: room.id }).historicalUnknownCount).toBe(1);
    expect(db.query("SELECT content FROM session_messages WHERE id='old-message'").get()).toEqual({ content: "Preserved message" });
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
