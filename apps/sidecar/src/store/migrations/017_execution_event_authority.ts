import type { Migration } from "../migrations";
import { ensureColumns, migrationChecksum } from "../migrations";

export const executionEventAuthorityMigration: Migration = {
  version: 17,
  name: "execution_event_authority",
  checksum: migrationChecksum(
    "017:execution-events:v2:legacy-v0-session-schema-step-provider-tool-identities-projection-checkpoints",
  ),
  up(db) {
    ensureColumns(db, "runtime_events", [
      "session_id TEXT",
      "schema_version INTEGER NOT NULL DEFAULT 1",
      "step_id TEXT",
      "provider_attempt_id TEXT",
      "tool_operation_id TEXT",
      "tool_attempt_id TEXT",
    ]);
    db.exec(`
      UPDATE runtime_events SET schema_version = 0;

      UPDATE runtime_events
      SET session_id = (
        SELECT session_id FROM agent_runs WHERE agent_runs.id = runtime_events.run_id
      )
      WHERE session_id IS NULL;

      UPDATE agent_runs
      SET event_seq = COALESCE(
        (SELECT MAX(seq) FROM runtime_events WHERE runtime_events.run_id = agent_runs.id),
        event_seq
      );

      CREATE INDEX idx_runtime_events_session_run_seq
        ON runtime_events (session_id, run_id, seq);

      CREATE TABLE runtime_projection_checkpoints (
        run_id TEXT NOT NULL,
        projection TEXT NOT NULL,
        projection_version INTEGER NOT NULL,
        last_seq INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, projection)
      );
    `);
  },
};
