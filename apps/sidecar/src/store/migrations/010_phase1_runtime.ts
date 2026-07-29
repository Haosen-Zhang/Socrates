import type { Migration } from "../migrations";
import { ensureColumns, migrationChecksum } from "../migrations";

/**
 * Phase 1 Runtime Persistence：单 Agent 状态机、事件 journal、LangGraph thread 映射。
 *
 * - agent_runs: +turn_id +event_seq +agent_state +thread_id（LangGraph checkpoint 关联）
 * - tool_calls:  +timeout_ms +retry_count
 * - runtime_events: 新建事件 journal 表，支持 SSE replay
 * - agent_states:  新建 agent 运行时状态表，per-agent per-run
 */
export const phase1RuntimeMigration: Migration = {
  version: 10,
  name: "phase1_runtime_state_machines_and_journal",
  checksum: migrationChecksum("010:phase1:v1:agent-runs-cols-tool-calls-cols-runtime-events-agent-states"),
  up(db) {
    // agent_runs — 新增列（向后兼容：全部有 DEFAULT 或 NULL 允许）
    ensureColumns(db, "agent_runs", [
      "turn_id TEXT",
      "event_seq INTEGER NOT NULL DEFAULT 0",
      "agent_state TEXT NOT NULL DEFAULT 'ready'",
      "thread_id TEXT", // LangGraph thread_id，用于 checkpoint 关联
    ]);

    // tool_calls — 新增列
    ensureColumns(db, "tool_calls", [
      "timeout_ms INTEGER NOT NULL DEFAULT 30000",
      "retry_count INTEGER NOT NULL DEFAULT 0",
    ]);

    // 事件 journal — SSE replay 和审计的数据源
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        turn_id TEXT,
        agent_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        UNIQUE (run_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_events_run_seq ON runtime_events (run_id, seq);
    `);

    // Agent 运行时状态 — per-agent per-run
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_states (
        agent_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, run_id)
      );
    `);

    // 将处于运行中但缺少 thread_id 的旧 run 标记为 interrupted
    // （Phase 1 之前没有 LangGraph thread，旧 run 无法恢复）
    db.query(`
      UPDATE agent_runs SET status = 'interrupted', error = 'phase1_migration', completed_at = ?
      WHERE status IN ('preparing', 'running', 'awaiting_approval') AND thread_id IS NULL
    `).run(new Date().toISOString());
  },
};
