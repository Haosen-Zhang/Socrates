import type { Database } from "bun:sqlite";
import { UNAVAILABLE_USAGE, type NormalizedUsage, type ReasoningEffort, type TokenUsage } from "@socrates/core";

export interface UsageSummary {
  agentId: string | null;
  current: NormalizedUsage;
  cumulative: NormalizedUsage;
  records: number;
}

export function normalizeTokenUsage(usage: TokenUsage | null | undefined, effort: ReasoningEffort | null = null): NormalizedUsage {
  if (!usage) return { ...UNAVAILABLE_USAGE, effort };
  const inputTokens = usage.inputTokens ?? null;
  const outputTokens = usage.outputTokens ?? null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.totalTokens ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
    cachedInputTokens: usage.cachedInputTokens ?? null,
    cacheWriteTokens: usage.cacheWriteTokens ?? null,
    reasoningTokens: usage.reasoningTokens ?? null,
    cost: null,
    currency: null,
    source: inputTokens === null && outputTokens === null ? "unavailable" : "provider",
    estimated: false,
    effort,
  };
}

export class UsageCollector {
  constructor(private readonly db: Database) {}

  record(input: { stableKey: string; sessionId?: string | null; roomId?: string | null; taskId?: string | null; turnId?: string | null; agentId?: string | null; usage: NormalizedUsage }): boolean {
    if (!input.sessionId && !input.roomId) throw new Error("usage_owner_required");
    const usage = input.usage;
    return this.db.query(`INSERT OR IGNORE INTO usage_records
      (id, stable_key, session_id, room_id, task_id, turn_id, agent_id, input_tokens, output_tokens, total_tokens,
       cached_input_tokens, cache_write_tokens, reasoning_tokens, cost, currency, source, estimated, effort, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), input.stableKey, input.sessionId ?? null, input.roomId ?? null, input.taskId ?? null, input.turnId ?? null, input.agentId ?? null,
        usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.cachedInputTokens, usage.cacheWriteTokens,
        usage.reasoningTokens, usage.cost, usage.currency, usage.source, usage.estimated ? 1 : 0, usage.effort, new Date().toISOString()).changes === 1;
  }

  summaries(taskId: string): UsageSummary[] {
    return summarizeRows(this.db.query<any, [string]>("SELECT * FROM usage_records WHERE task_id = ? ORDER BY created_at, rowid").all(taskId));
  }

  sessionSummaries(sessionId: string): UsageSummary[] {
    return summarizeRows(this.db.query<any, [string]>("SELECT * FROM usage_records WHERE session_id = ? ORDER BY created_at, rowid").all(sessionId));
  }

  roomSummaries(roomId: string): UsageSummary[] {
    return summarizeRows(this.db.query<any, [string]>("SELECT * FROM usage_records WHERE room_id = ? ORDER BY created_at, rowid").all(roomId));
  }
}

function summarizeRows(rows: any[]): UsageSummary[] {
    const grouped = new Map<string | null, typeof rows>();
    for (const row of rows) {
      const key = row.agent_id as string | null;
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    return Array.from(grouped, ([agentId, records]) => ({
      agentId,
      current: fromRow(records.at(-1)),
      cumulative: aggregate(records),
      records: records.length,
    }));
}

function fromRow(row: any): NormalizedUsage {
  if (!row) return { ...UNAVAILABLE_USAGE };
  return {
    inputTokens: row.input_tokens, outputTokens: row.output_tokens, totalTokens: row.total_tokens,
    cachedInputTokens: row.cached_input_tokens, cacheWriteTokens: row.cache_write_tokens,
    reasoningTokens: row.reasoning_tokens, cost: row.cost, currency: row.currency,
    source: row.source, estimated: row.estimated === 1, effort: row.effort,
  };
}

function nullableSum(rows: any[], key: string): number | null {
  const values = rows.map((row) => row[key]).filter((value): value is number => typeof value === "number");
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function aggregate(rows: any[]): NormalizedUsage {
  const latest = fromRow(rows.at(-1));
  return {
    inputTokens: nullableSum(rows, "input_tokens"), outputTokens: nullableSum(rows, "output_tokens"),
    totalTokens: nullableSum(rows, "total_tokens"), cachedInputTokens: nullableSum(rows, "cached_input_tokens"),
    cacheWriteTokens: nullableSum(rows, "cache_write_tokens"), reasoningTokens: nullableSum(rows, "reasoning_tokens"),
    cost: nullableSum(rows, "cost"), currency: rows.every((row) => row.currency === latest.currency) ? latest.currency : null,
    source: rows.some((row) => row.source === "estimated") ? "estimated" : rows.some((row) => row.source === "provider") ? "provider" : "unavailable",
    estimated: rows.some((row) => row.estimated === 1), effort: latest.effort,
  };
}
