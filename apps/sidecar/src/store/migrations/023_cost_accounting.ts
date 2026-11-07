import { migrationChecksum, type Migration } from "../migrations";

/** Frozen early 023 already applied by desktop users. Additions belong in 024+. */
export const costAccountingMigration: Migration = {
  version: 23, name: "cost_invocations_prices_budgets",
  checksum: migrationChecksum("023:cost-v1:immutable-snapshots:invocations:budget-accounts-reservations-adjustments-topups:quotes"),
  acceptsAppliedChecksum(db, checksum) {
    // Also recognize the complete 023 variant written during this same local
    // implementation. Require its actual additions; arbitrary drift stays fatal.
    if (checksum !== "04bbe3e3613092a0bf97050050f0fc3677b3cc05d1834851830c947946b08e7d") return false;
    const has = (table: string, required: string[]) => {
      const columns = db.query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)").all(table).map(column => column.name);
      return required.every(name => columns.includes(name));
    };
    return has("cost_actions", ["root_task_id", "request_id", "kind", "state", "result_json", "created_at"])
      && has("cost_legacy_usage", ["usage_id", "session_id", "room_id", "task_id", "agent_id", "usage_json"])
      && has("cost_adjustments", ["actual_total_atomic"]);
  },
  up(db) {
    db.exec(`
      CREATE TABLE cost_price_snapshots (
        id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model_id TEXT NOT NULL, protocol TEXT NOT NULL,
        base_url TEXT NOT NULL, service_tier TEXT NOT NULL, source TEXT NOT NULL,
        content_hash TEXT NOT NULL UNIQUE, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX idx_cost_prices_identity ON cost_price_snapshots(provider_id,model_id,protocol,base_url,service_tier,created_at);
      CREATE TABLE cost_invocations (
        id TEXT PRIMARY KEY, logical_step_id TEXT NOT NULL, attempt_no INTEGER NOT NULL,
        room_id TEXT NOT NULL, root_task_id TEXT NOT NULL, run_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        identity_json TEXT NOT NULL, price_snapshot_id TEXT, state TEXT NOT NULL,
        status TEXT NOT NULL, usage_json TEXT, lines_json TEXT NOT NULL DEFAULT '[]', unknown_json TEXT NOT NULL DEFAULT '[]',
        currency TEXT, amount_atomic TEXT, request_id TEXT, finish_reason TEXT, outcome TEXT,
        adapter_version TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(price_snapshot_id) REFERENCES cost_price_snapshots(id)
      );
      CREATE INDEX idx_cost_invocations_task ON cost_invocations(root_task_id,created_at);
      CREATE INDEX idx_cost_invocations_room ON cost_invocations(room_id,created_at);
      CREATE TABLE cost_budget_accounts (
        root_task_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, mode TEXT NOT NULL, limit_atomic TEXT NOT NULL,
        parent_id TEXT, revision INTEGER NOT NULL DEFAULT 1, blocked_reason TEXT, blocked_json TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(parent_id) REFERENCES cost_budget_accounts(root_task_id)
      );
      CREATE INDEX idx_cost_budget_parent ON cost_budget_accounts(parent_id);
      CREATE TABLE cost_reservations (
        invocation_id TEXT PRIMARY KEY, root_task_id TEXT NOT NULL, amount_atomic TEXT NOT NULL,
        state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(invocation_id) REFERENCES cost_invocations(id),
        FOREIGN KEY(root_task_id) REFERENCES cost_budget_accounts(root_task_id)
      );
      CREATE INDEX idx_cost_reservations_task ON cost_reservations(root_task_id,state);
      CREATE TABLE cost_budget_increases (
        root_task_id TEXT NOT NULL, request_id TEXT NOT NULL, expected_revision INTEGER NOT NULL,
        amount_atomic TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(root_task_id,request_id), FOREIGN KEY(root_task_id) REFERENCES cost_budget_accounts(root_task_id)
      );
      CREATE TABLE cost_adjustments (
        id TEXT PRIMARY KEY, invocation_id TEXT NOT NULL, request_id TEXT NOT NULL, amount_atomic TEXT NOT NULL,
        currency TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(invocation_id,request_id), FOREIGN KEY(invocation_id) REFERENCES cost_invocations(id)
      );
      CREATE TABLE cost_quotes (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL, input_hash TEXT NOT NULL, quote_json TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
    `);
  },
};
