import { migrationChecksum, type Migration } from '../migrations';
export const workInteractionsMigration:Migration={version:38,name:'work_interactions',checksum:migrationChecksum('038:interactions-leader-inbox:v2'),up(db){db.exec(`
CREATE TABLE work_interactions(id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, work_item_id TEXT REFERENCES work_items(id),room_id TEXT REFERENCES sessions(id),client_request_id TEXT NOT NULL,input_json TEXT NOT NULL,status TEXT NOT NULL,command_id TEXT REFERENCES room_commands(id),reason TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(scope_key,client_request_id));
CREATE TABLE leader_evaluations(id TEXT PRIMARY KEY,work_item_id TEXT NOT NULL REFERENCES work_items(id),task_id TEXT NOT NULL REFERENCES multi_tasks(id),status TEXT NOT NULL,reason TEXT,decision_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX leader_pending ON leader_evaluations(work_item_id) WHERE status IN ('pending','running');
CREATE TABLE leader_report_receipts(event_id TEXT PRIMARY KEY,evaluation_id TEXT REFERENCES leader_evaluations(id));
INSERT INTO leader_report_receipts(event_id,evaluation_id) SELECT event_id,NULL FROM task_events WHERE type IN ('multi.package_finished','multi.package_reviewed');
CREATE TABLE inbox_delivery(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,revision INTEGER NOT NULL,read_revision INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL);
CREATE TABLE inbox_notifications(id TEXT PRIMARY KEY,item_id TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(item_id,revision));
`);}};
