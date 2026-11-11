import { migrationChecksum, type Migration } from '../migrations';
export const workItemPreviewsMigration: Migration = {
 version:36,name:'work_item_previews',checksum:migrationChecksum('036:work-item-previews:v1'),
 up(db){db.exec(`CREATE TABLE work_item_previews(id TEXT PRIMARY KEY,work_item_id TEXT NOT NULL REFERENCES work_items(id),preview_json TEXT NOT NULL,input_json TEXT NOT NULL,owner_json TEXT NOT NULL);
 ALTER TABLE work_item_reviews ADD COLUMN run_id TEXT REFERENCES work_item_runs(id);`);}
};
