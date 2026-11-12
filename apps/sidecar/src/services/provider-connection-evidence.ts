import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { TestOutcome } from '@socrates/core';

export const CONNECTION_EVIDENCE_TTL_MS = 5 * 60_000;
type Configuration = {type:string;base_url:string;api_key_ref:string;updated_at:string};
export function providerFingerprint(row:Configuration):string {
  return createHash('sha256').update(JSON.stringify([row.type,row.base_url,row.api_key_ref,row.updated_at])).digest('hex');
}
export function recordConnectionEvidence(db:Database, id:string, fingerprint:string, outcome:TestOutcome, now=Date.now()):void {
  const current=db.query<Configuration,[string]>('SELECT type,base_url,api_key_ref,updated_at FROM providers WHERE id=?').get(id);
  // A probe completed against an older key/configuration must never certify its replacement.
  if(!current || providerFingerprint(current)!==fingerprint)return;
  db.query(`INSERT INTO provider_connection_evidence VALUES(?,?,?,?,?) ON CONFLICT(provider_id) DO UPDATE SET fingerprint=excluded.fingerprint,outcome=excluded.outcome,checked_at=excluded.checked_at,expires_at=excluded.expires_at`)
    .run(id,fingerprint,outcome,new Date(now).toISOString(),new Date(now+CONNECTION_EVIDENCE_TTL_MS).toISOString());
}
