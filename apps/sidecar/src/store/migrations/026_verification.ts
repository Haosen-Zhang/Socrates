import { migrationChecksum, type Migration } from "../migrations";

/** Immutable plans/evidence and explicitly versioned current run projections.
 * Room deletion cascades; conversation rewind never rewrites these facts. */
export const verificationMigration: Migration = {
  version: 26, name: "verification",
  checksum: migrationChecksum("026:verification-plans-runs-evidence-acceptance:1"),
  up(db) {
    db.exec(`CREATE TABLE verification_plans (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      root_task_id TEXT NOT NULL, package_id TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL,
      request_id TEXT NOT NULL, request_hash TEXT NOT NULL, plan_json TEXT NOT NULL,
      created_at TEXT NOT NULL, UNIQUE(room_id,request_id), UNIQUE(room_id,root_task_id,package_id,version)
    );
    CREATE TABLE verification_runs (
      id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES verification_plans(id) ON DELETE CASCADE,
      room_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      root_task_id TEXT NOT NULL, package_id TEXT NOT NULL DEFAULT '', request_id TEXT NOT NULL,
      mode TEXT NOT NULL, status TEXT NOT NULL, run_json TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(plan_id,request_id)
    );
    CREATE INDEX verification_runs_target ON verification_runs(room_id,root_task_id,package_id,mode);
    CREATE TABLE verification_evidence (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES verification_runs(id) ON DELETE CASCADE,
      check_id TEXT NOT NULL, evidence_json TEXT NOT NULL, UNIQUE(run_id,check_id)
    );
    CREATE TABLE verification_requests (
      room_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,
      PRIMARY KEY(room_id,request_id)
    );
    CREATE TABLE verification_acceptance (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      root_task_id TEXT NOT NULL, package_id TEXT NOT NULL DEFAULT '',
      plan_id TEXT NOT NULL REFERENCES verification_plans(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES verification_runs(id) ON DELETE CASCADE,
      snapshot_hash TEXT NOT NULL, request_id TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(room_id,request_id)
    );`);
  },
};
