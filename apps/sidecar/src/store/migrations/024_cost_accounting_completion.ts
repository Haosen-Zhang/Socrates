import { ensureColumns, migrationChecksum, type Migration } from "../migrations";

/** Append-only upgrade for both early and complete 023 installations. */
export const costAccountingCompletionMigration: Migration = {
  version: 24,
  name: "cost_accounting_completion",
  checksum: migrationChecksum("024:cost-accounting-completion:actions:invoice-total:legacy-snapshot-if-absent:v1"),
  up(db) {
    ensureColumns(db, "cost_adjustments", ["actual_total_atomic TEXT"]);
    db.exec(`CREATE TABLE IF NOT EXISTS cost_actions (
      root_task_id TEXT NOT NULL, request_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
      result_json TEXT, created_at TEXT NOT NULL, PRIMARY KEY(root_task_id,request_id,kind)
    )`);
    // A complete 023 already captured its historical cutoff. Do not relabel
    // newer token observations as historical unknown costs on that path.
    const captured = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='cost_legacy_usage'").get();
    if (captured) return;
    db.exec(`CREATE TABLE cost_legacy_usage (
      usage_id TEXT PRIMARY KEY, session_id TEXT, room_id TEXT, task_id TEXT,
      agent_id TEXT, usage_json TEXT NOT NULL
    );
    INSERT INTO cost_legacy_usage(usage_id,session_id,room_id,task_id,agent_id,usage_json)
      SELECT id,session_id,room_id,task_id,agent_id,json_object('inputTokens',input_tokens,'outputTokens',output_tokens,'totalTokens',total_tokens,
        'cachedInputTokens',cached_input_tokens,'cacheWriteTokens',cache_write_tokens,'reasoningTokens',reasoning_tokens)
      FROM usage_records WHERE cost IS NULL;`);
  },
};
