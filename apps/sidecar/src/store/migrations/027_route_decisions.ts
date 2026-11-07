import { migrationChecksum, type Migration } from "../migrations";

/** One immutable initial decision per room command. Attempts reference this envelope. */
export const routeDecisionsMigration: Migration = {
  version:27,name:"route_decisions",checksum:migrationChecksum("027:immutable-routing-decisions:root-owner:1"),
  up(db){db.exec(`CREATE TABLE routing_decisions (
    id TEXT PRIMARY KEY, root_task_id TEXT NOT NULL UNIQUE,
    room_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    quote_id TEXT, binding_hash TEXT NOT NULL, decision_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX routing_decisions_room ON routing_decisions(room_id,created_at);`);},
};
