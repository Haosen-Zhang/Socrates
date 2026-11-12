import { migrationChecksum, type Migration } from '../migrations';
export const squadIntegrationMigration: Migration = {
 version:39,name:'squad_integration',checksum:migrationChecksum('039:squad-routing-and-command-attribution:v1'),
 up(db){db.exec(`
 ALTER TABLE work_item_reviews ADD COLUMN verification_run_id TEXT;
 ALTER TABLE squad_templates ADD COLUMN routing_preset TEXT NOT NULL DEFAULT 'manual' CHECK(routing_preset IN ('manual','economy','balanced','quality','custom'));
 CREATE TABLE squad_command_snapshots(root_task_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, workspace_id TEXT NOT NULL, squad_id TEXT NOT NULL, revision INTEGER NOT NULL, leader_agent_id TEXT NOT NULL, work_item_id TEXT, work_item_run_id TEXT, created_at TEXT NOT NULL);
 CREATE INDEX squad_command_scope ON squad_command_snapshots(squad_id,root_task_id);
 `);}
};
