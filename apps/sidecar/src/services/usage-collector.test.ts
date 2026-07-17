import { describe, expect, it } from "bun:test";
import { openDb } from "../db";
import { UsageCollector, normalizeTokenUsage } from "./usage-collector";

describe("UsageCollector", () => {
  it("keeps unavailable fields null and does not double count a replayed stable key", () => {
    const db = openDb(":memory:");
    const now = new Date().toISOString();
    db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES ('w', '/tmp', '/tmp', 'w', 'w', ?, ?)").run(now, now);
    db.query("INSERT INTO sessions (id, title, mode, workspace_id, status, created_at, updated_at) VALUES ('s', 's', 'multi_agent', 'w', 'idle', ?, ?)").run(now, now);
    const collector = new UsageCollector(db);
    expect(collector.record({ stableKey: "one", sessionId: "s", taskId: "t", agentId: "a", usage: normalizeTokenUsage({ inputTokens: 2, outputTokens: 3 }) })).toBe(true);
    expect(collector.record({ stableKey: "one", sessionId: "s", taskId: "t", agentId: "a", usage: normalizeTokenUsage({ inputTokens: 99 }) })).toBe(false);
    collector.record({ stableKey: "two", sessionId: "s", taskId: "t", agentId: "a", usage: normalizeTokenUsage({ outputTokens: 4 }) });
    expect(collector.summaries("t")[0]).toMatchObject({
      records: 2,
      current: { inputTokens: null, outputTokens: 4 },
      cumulative: { inputTokens: 2, outputTokens: 7, cachedInputTokens: null, cost: null },
    });
  });
});
