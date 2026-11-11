import { migrationChecksum, type Migration } from '../migrations';
export const agentConnectionEvidenceMigration: Migration = {
  version:37, name:'agent_connection_evidence', checksum:migrationChecksum('037:provider-config-fingerprint-models-probe-expiry:v1'),
  up(db) { db.exec(`CREATE TABLE provider_connection_evidence (
    provider_id TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL, outcome TEXT NOT NULL, checked_at TEXT NOT NULL, expires_at TEXT NOT NULL
  )`); }
};
