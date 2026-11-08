import { migrationChecksum,type Migration } from '../migrations';
export const flightRecorderMigration:Migration={version:29,name:'flight_recorder',checksum:migrationChecksum('029:local-audit-projection-cursors-retention:v1'),up(db){db.exec(`
CREATE TABLE flight_records(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,room_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,root_task_id TEXT NOT NULL,source TEXT NOT NULL,source_sequence INTEGER NOT NULL,stage TEXT NOT NULL,agent_id TEXT,record_json TEXT NOT NULL,content_hash TEXT NOT NULL);
CREATE INDEX flight_room_seq ON flight_records(room_id,sequence);
CREATE TABLE flight_deleted(id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE);
CREATE TABLE flight_cursors(room_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,source TEXT NOT NULL,cursor INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(room_id,source));
CREATE TABLE flight_retention(room_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,days INTEGER NOT NULL DEFAULT 30,max_events INTEGER NOT NULL DEFAULT 10000,removed INTEGER NOT NULL DEFAULT 0);
`);}};
