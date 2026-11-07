import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalManager } from "../../approvals/manager";
import { runMigrations } from "../migrations";
import { migrations } from "./index";

test("append-only session approval upgrade retains old facts without converting them into broad permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "socrates-approval-migration-")), path = join(root, "test.db");
  let db = new Database(path);
  try {
    runMigrations(db, migrations.filter(m => m.version <= 24));
    db.exec(`INSERT INTO approval_requests(id,task_id,kind,subject_id,input_hash,workspace_identity,attempt_id,policy_version,risk,fresh_human_required,status,created_at)
      VALUES ('old','task','write_file','old-call','old-hash','workspace','attempt',1,'medium',0,'allowed','now');
      INSERT INTO approval_decisions(id,request_id,client_decision_key,decision,decided_at) VALUES ('old-decision','old','old-key','allow_session','now');
      INSERT INTO permission_grants(id,request_id,workspace_identity,subject_hash,scope) VALUES ('old-grant','old','workspace','old-hash','session');`);
    expect(runMigrations(db, migrations)).toEqual([25]);
    expect(db.query("SELECT session_id,tool_generation FROM approval_requests WHERE id='old'").get()).toEqual({ session_id: null, tool_generation: null });
    let manager = new ApprovalManager(db);
    const next = manager.request({ taskId: "new-task", kind: "write_file", subjectId: "new-call", inputHash: "new-input", workspaceIdentity: "workspace",
      attemptId: "new-attempt", policyVersion: 1, risk: "medium", freshHumanRequired: false, sessionId: "room", toolGeneration: 1 });
    expect(manager.hasSessionGrant(next)).toBe(false);
    manager.decide(next.id, { clientDecisionKey: "scoped", decision: "allow_session" });
    db.close(); db = new Database(path);
    manager = new ApprovalManager(db);
    expect(runMigrations(db, migrations)).toEqual([]);
    expect(manager.hasSessionGrant(next)).toBe(true);
    expect(db.query("SELECT COUNT(*) AS n FROM permission_grants").get()).toEqual({ n: 2 });
    expect(db.query("SELECT subject_hash FROM permission_grants WHERE id='old-grant'").get()).toEqual({ subject_hash: "old-hash" });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
