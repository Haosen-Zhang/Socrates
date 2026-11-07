import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../migrations";
import { migrations } from "./index";
import { SessionStore } from "../session-store";

test("adaptive workflow migration keeps frozen decisions, history and costs intact",()=>{
  const db=new Database(":memory:");
  try{
    db.exec("PRAGMA foreign_keys=ON");runMigrations(db,migrations.filter(item=>item.version<=27));
    const room=new SessionStore(db).create({title:"Existing conversation",mode:"chat",primaryAgentId:"a",agents:[{agentId:"a",snapshot:{nickname:"a"},executionEligible:false}]});
    db.query("INSERT INTO room_commands(id,room_id,client_request_id,fingerprint,input_json,kind,status,created_at,updated_at) VALUES('root',?,'request','hash','{}','direct','completed','before','before')").run(room.id);
    db.query("INSERT INTO routing_decisions(id,root_task_id,room_id,quote_id,binding_hash,decision_json,created_at) VALUES('route','root',?,NULL,'frozen','{\"preserved\":true}','before')").run(room.id);
    db.query("INSERT INTO history_projection_state(session_id,projected_offset,projected_sequence,current_epoch,status,updated_at) VALUES(?,321,5,2,'ready','before')").run(room.id);
    const tables=["sessions","room_commands","routing_decisions","history_projection_state","cost_invocations","verification_plans"];
    const before=Object.fromEntries(tables.map(table=>[table,db.query(`SELECT * FROM ${table}`).all()]));
    expect(runMigrations(db,migrations.filter(item=>item.version<=28))).toEqual([28]);
    for(const table of tables)expect(db.query(`SELECT * FROM ${table}`).all()).toEqual(before[table]);
    expect(db.query("SELECT * FROM adaptive_workflows").all()).toEqual([]);
    expect(runMigrations(db,migrations.filter(item=>item.version<=28))).toEqual([]);
  }finally{db.close();}
});
