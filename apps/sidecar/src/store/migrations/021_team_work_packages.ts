import { migrationChecksum, type Migration } from "../migrations";

export const teamWorkPackagesMigration: Migration = {
  version: 21, name: "team_work_packages",
  checksum: migrationChecksum("021:team-work-packages-dependency-attempts-review:v1"),
  up(db) {
    db.exec(`CREATE TABLE work_packages (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES multi_tasks(id) ON DELETE CASCADE,
      plan_version INTEGER NOT NULL, definition_json TEXT NOT NULL,
      state TEXT NOT NULL, attempt_no INTEGER NOT NULL DEFAULT 0,
      run_id TEXT, result TEXT, failure_reason TEXT, review_notes TEXT,
      rework_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX work_packages_task ON work_packages(task_id);
    CREATE TABLE work_package_attempts (
      id TEXT PRIMARY KEY, package_id TEXT NOT NULL REFERENCES work_packages(id) ON DELETE CASCADE,
      attempt_no INTEGER NOT NULL, run_id TEXT NOT NULL, status TEXT NOT NULL,
      result TEXT, failure_reason TEXT, started_at TEXT NOT NULL, completed_at TEXT,
      UNIQUE(package_id, attempt_no)
    );`);
  },
};
