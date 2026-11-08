import { migrationChecksum, type Migration } from "../migrations";
export const arenaMigration: Migration = {
	version: 31,
	name: "arena",
	checksum: migrationChecksum("031:arena:experiments-trials-snapshot-1"),
	up(db) {
		db.exec(
			`CREATE TABLE arena_experiments(id TEXT PRIMARY KEY,room_id TEXT NOT NULL,request_id TEXT NOT NULL,definition_hash TEXT NOT NULL,experiment_json TEXT NOT NULL,snapshot_json TEXT NOT NULL,UNIQUE(room_id,request_id)); CREATE TABLE arena_trials(id TEXT PRIMARY KEY,experiment_id TEXT NOT NULL REFERENCES arena_experiments(id),room_id TEXT NOT NULL UNIQUE,trial_json TEXT NOT NULL); CREATE INDEX arena_trials_experiment ON arena_trials(experiment_id);`,
		);
	},
};
