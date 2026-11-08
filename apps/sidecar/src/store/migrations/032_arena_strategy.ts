import { migrationChecksum, type Migration } from "../migrations";
export const arenaStrategyMigration: Migration = {
	version: 32,
	name: "arena_strategy",
	checksum: migrationChecksum("032:arena-strategy:preview-version-cas:1"),
	up(db) {
		db.exec(
			`CREATE TABLE arena_strategy_previews(hash TEXT PRIMARY KEY,room_id TEXT NOT NULL,preview_json TEXT NOT NULL);CREATE TABLE arena_strategy_versions(id TEXT PRIMARY KEY,room_id TEXT NOT NULL,request_id TEXT NOT NULL,preview_hash TEXT NOT NULL,version_json TEXT NOT NULL,UNIQUE(room_id,request_id));CREATE TABLE arena_strategy_rollbacks(room_id TEXT NOT NULL,request_id TEXT NOT NULL,version_id TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(room_id,request_id));`,
		);
	},
};
