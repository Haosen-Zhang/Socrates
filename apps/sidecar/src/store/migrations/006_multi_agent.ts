import type { Migration } from "../migrations";
import { migrationChecksum } from "../migrations";

export const multiAgentMigration: Migration = {
  version: 6,
  name: "multi_agent_tasks_plans_and_decisions",
  checksum: migrationChecksum("006:multi:v1:tasks-attempts-turns-plans-decisions"),
  up(db) {
    db.exec(`
      CREATE TABLE multi_tasks (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL,
        state TEXT NOT NULL, resume_from_state TEXT, attempt_no INTEGER NOT NULL DEFAULT 1,
        config_json TEXT NOT NULL, discussion_cutoff INTEGER,
        execution_agent_id TEXT, approved_plan_version INTEGER, approved_plan_hash TEXT,
        terminal_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
      CREATE INDEX idx_multi_tasks_session ON multi_tasks (session_id, created_at);
      CREATE TABLE multi_task_attempts (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_no INTEGER NOT NULL,
        status TEXT NOT NULL, checkpoint_json TEXT, started_at TEXT NOT NULL, ended_at TEXT,
        UNIQUE (task_id, attempt_no), FOREIGN KEY (task_id) REFERENCES multi_tasks(id) ON DELETE CASCADE
      );
      CREATE TABLE multi_turns (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
        stable_key TEXT NOT NULL UNIQUE, phase TEXT NOT NULL, round INTEGER NOT NULL,
        participant_index INTEGER NOT NULL, agent_id TEXT NOT NULL, snapshot_json TEXT NOT NULL,
        status TEXT NOT NULL, content TEXT, usage_json TEXT, error TEXT,
        outcome_certainty TEXT NOT NULL DEFAULT 'known', started_at TEXT NOT NULL, completed_at TEXT,
        FOREIGN KEY (task_id) REFERENCES multi_tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (attempt_id) REFERENCES multi_task_attempts(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_multi_turns_task ON multi_turns (task_id, participant_index);
      CREATE TABLE plan_versions (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, version INTEGER NOT NULL,
        parent_version INTEGER, content_json TEXT NOT NULL, content_hash TEXT NOT NULL,
        evidence_hash TEXT NOT NULL, created_by TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE (task_id, version),
        FOREIGN KEY (task_id) REFERENCES multi_tasks(id) ON DELETE CASCADE
      );
      CREATE TABLE plan_decisions (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, plan_version INTEGER NOT NULL,
        plan_hash TEXT NOT NULL, client_decision_key TEXT NOT NULL UNIQUE,
        decision TEXT NOT NULL, reason TEXT, decided_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES multi_tasks(id) ON DELETE CASCADE
      );
    `);
  },
};
