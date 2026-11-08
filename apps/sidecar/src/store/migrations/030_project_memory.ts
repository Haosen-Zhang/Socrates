import { migrationChecksum, type Migration } from "../migrations";
export const projectMemoryMigration: Migration = {
	version: 30,
	name: "project_memory",
	checksum: migrationChecksum(
		"030:project-memory:versions-freeze-fts-bindings:1",
	),
	up(db) {
		db.exec(`
CREATE TABLE memory_entries(id TEXT NOT NULL,version INTEGER NOT NULL,project_id TEXT NOT NULL,entry_json TEXT NOT NULL,PRIMARY KEY(id,version));
CREATE INDEX memory_project ON memory_entries(project_id);
CREATE VIRTUAL TABLE memory_search USING fts5(id UNINDEXED,content,tokenize='unicode61');
CREATE TABLE memory_bindings(room_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,entry_ids_json TEXT NOT NULL);
CREATE TABLE memory_freezes(root_task_id TEXT PRIMARY KEY,room_id TEXT NOT NULL,entries_json TEXT NOT NULL,created_at TEXT NOT NULL,task_cursor INTEGER NOT NULL);
CREATE TABLE memory_manifests(id TEXT PRIMARY KEY,root_task_id TEXT NOT NULL,provider_id TEXT NOT NULL,manifest_json TEXT NOT NULL,UNIQUE(root_task_id,provider_id));
CREATE TABLE memory_imports(project_id TEXT NOT NULL,fingerprint TEXT NOT NULL,entry_id TEXT NOT NULL,PRIMARY KEY(project_id,fingerprint));
`);
	},
};
