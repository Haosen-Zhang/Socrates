import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../db';
import { assertMigrationCompatibility, runMigrations } from './migrations';
import { migrations } from './migrations/index';
import { SessionStore } from './session-store';

test('Alpha data upgrade preserves approvals, packages, pending tool outcomes and unknown historical costs, including backup and reopen', () => {
 const dir=mkdtempSync(join(tmpdir(),'socrates-p08-upgrade-')), path=join(dir,'alpha.db');
 let db=new Database(path);
 try {
  runMigrations(db,migrations.filter(m=>m.version<=22));
  const room=new SessionStore(db).create({title:'Alpha historical room',mode:'chat',primaryAgentId:'a',agents:[{agentId:'a',snapshot:{nickname:'Frozen member',modelId:'legacy-model'},executionEligible:false}]});
  db.exec(`INSERT INTO multi_tasks(id,session_id,prompt,state,config_json,approved_plan_version,approved_plan_hash,created_at,updated_at) VALUES('task','${room.id}','historic task','awaiting_approval','{}',1,'approved-hash','before','before');
  INSERT INTO plan_versions(id,task_id,version,content_json,content_hash,evidence_hash,created_by,status,created_at) VALUES('plan','task',1,'{"historical":true}','approved-hash','evidence','a','approved','before');
  INSERT INTO plan_decisions(id,task_id,plan_version,plan_hash,client_decision_key,decision,decided_at) VALUES('decision','task',1,'approved-hash','key','approve','before');
  INSERT INTO approval_requests(id,task_id,kind,subject_id,input_hash,workspace_identity,attempt_id,policy_version,risk,fresh_human_required,status,created_at) VALUES('pending-approval','task','tool','tool','hash','workspace','attempt',1,'write',1,'pending','before');
  INSERT INTO work_packages(id,task_id,plan_version,definition_json,state,created_at,updated_at,result) VALUES('package','task',1,'{"title":"old package"}','completed','before','before','legacy success');
  INSERT INTO tool_calls(id,stable_key,session_id,task_id,attempt_id,turn_id,agent_id,name,generation,input_json,input_hash,workspace_identity,policy_version,risk,idempotency,status,created_at,updated_at,recovery_disposition) VALUES('tool','tool-key','${room.id}','task','attempt','turn','a','write_file',1,'{}','hash','workspace',1,'write','unsafe','outcome_unknown','before','before','requires_review');
  INSERT INTO tool_attempts(id,tool_operation_id,attempt_no,status,started_at) VALUES('attempt','tool',1,'outcome_unknown','before');
  INSERT INTO usage_records(id,stable_key,session_id,task_id,agent_id,input_tokens,output_tokens,total_tokens,source,estimated,created_at) VALUES('usage','usage-key','${room.id}','task','a',12,3,15,'provider',0,'before');
  INSERT INTO session_messages(id,session_id,role,content,status,created_at) VALUES('history','${room.id}','assistant','Historical completion','completed','before');`);
  const tables=['sessions','session_agents','session_messages','multi_tasks','plan_versions','plan_decisions','work_packages','tool_calls','tool_attempts','usage_records','approval_requests'];
  const columns=Object.fromEntries(tables.map(name=>[name,db.query<{name:string},[]>(`PRAGMA table_info(${name})`).all().map(c=>c.name).join(",")]));
  const snapshot=()=>Object.fromEntries(tables.map(name=>[name,db.query(`SELECT ${columns[name]} FROM ${name} ORDER BY rowid`).all()]));
  const before=snapshot();db.close(); db=openDb(path);
  expect(snapshot()).toEqual(before);
  for(const table of ['verification_evidence','verification_runs','cost_invocations','cost_price_snapshots']) expect(db.query(`SELECT count(*) n FROM ${table}`).get()).toEqual({n:0});
  expect(db.query('SELECT cost FROM usage_records').get()).toEqual({cost:null});
  expect(runMigrations(db,migrations)).toEqual([]);
  const backups=readdirSync(dir).filter(name=>name.startsWith('alpha.db.backup-'));expect(backups).toHaveLength(1);
  const backup=new Database(join(dir,backups[0]!),{readonly:true});
  try {expect(backup.query('SELECT MAX(version) v FROM schema_migrations').get()).toEqual({v:22});expect(backup.query('SELECT content_hash FROM plan_versions').get()).toEqual({content_hash:'approved-hash'});expect(backup.query('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});}finally{backup.close();}
  db.close();db=openDb(path);expect(snapshot()).toEqual(before);expect(readdirSync(dir).filter(name=>name.startsWith('alpha.db.backup-'))).toHaveLength(1);
  expect(()=>assertMigrationCompatibility(db,migrations.filter(m=>m.version<=22))).toThrow('unknown_applied_migration:23');
  expect(snapshot()).toEqual(before);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('newer schema is refused before journal changes or backup and remains readable',()=>{
 const dir=mkdtempSync(join(tmpdir(),'socrates-p08-future-')),path=join(dir,'future.db');
 const db=new Database(path);
 try{runMigrations(db,migrations);db.exec("INSERT INTO schema_migrations VALUES(999,'future','checksum','future'); CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES('keep');");db.close();expect(()=>openDb(path)).toThrow('unknown_applied_migration:999');
 const read=new Database(path,{readonly:true});try{expect(read.query('PRAGMA journal_mode').get()).toEqual({journal_mode:'delete'});expect(read.query('SELECT * FROM future_data').get()).toEqual({value:'keep'});}finally{read.close();}
 expect(readdirSync(dir)).toEqual(['future.db']);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
