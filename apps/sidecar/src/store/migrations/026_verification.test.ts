import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../migrations";
import { migrations } from "./index";
import { SessionStore } from "../session-store";

test("verification migration preserves historical messages, approvals and history offsets across reopen", () => {
  const root=mkdtempSync(join(tmpdir(),"socrates-verification-migration-")),path=join(root,"database.sqlite");
  let db=new Database(path);
  try {
    db.exec("PRAGMA foreign_keys=ON");runMigrations(db,migrations.filter(m=>m.version<=25));
    const room=new SessionStore(db).create({title:"Historic room",mode:"chat",primaryAgentId:"agent",agents:[{agentId:"agent",snapshot:{nickname:"Historic member"},executionEligible:false}]});
    db.query("INSERT INTO history_projection_state(session_id,projected_offset,projected_sequence,current_epoch,status,updated_at) VALUES(?,1234,7,1,'ready','before')").run(room.id);
    db.exec("INSERT INTO approval_requests(id,task_id,kind,subject_id,input_hash,workspace_identity,attempt_id,policy_version,risk,fresh_human_required,status,created_at) VALUES('historic','task','run_command','tool','input','workspace','attempt',1,'high',1,'denied','before')");
    const before={room:db.query("SELECT * FROM sessions WHERE id=?").get(room.id),history:db.query("SELECT * FROM history_projection_state").all(),approvals:db.query("SELECT * FROM approval_requests").all()};
    expect(runMigrations(db,migrations.filter(m=>m.version<=26))).toEqual([26]);
    expect(db.query("SELECT * FROM verification_plans").all()).toEqual([]);
    expect(db.query("SELECT * FROM sessions WHERE id=?").get(room.id)).toEqual(before.room);
    expect(db.query("SELECT * FROM history_projection_state").all()).toEqual(before.history);
    expect(db.query("SELECT * FROM approval_requests").all()).toEqual(before.approvals);
    db.close();db=new Database(path);
    expect(runMigrations(db,migrations.filter(m=>m.version<=26))).toEqual([]);
    expect(new SessionStore(db).get(room.id)?.title).toBe("Historic room");
  } finally {db.close();rmSync(root,{recursive:true,force:true});}
});
