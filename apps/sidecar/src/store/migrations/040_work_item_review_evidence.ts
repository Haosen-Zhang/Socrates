import { migrationChecksum, type Migration } from '../migrations';
export const workItemReviewEvidenceMigration: Migration = {
 version:40,name:'work_item_review_evidence',checksum:migrationChecksum('040:effective-verification-review-revision:v1'),
 up(db){db.exec('ALTER TABLE work_item_reviews ADD COLUMN verification_revision TEXT');}
};
