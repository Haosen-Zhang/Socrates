import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../migrations";
import { migrations } from "./index";
import { SessionStore } from "../session-store";
import { HistoryStore } from "../history-store";
import { ConversationMemoryStore } from "../conversation-memory-store";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function oldDatabase() {
  const db = new Database(":memory:");
  runMigrations(db, migrations.filter(m => m.version === 1));
  db.exec(`INSERT INTO agents (id,display_name,nickname,provider_id,model_id,role,system_prompt,created_at,updated_at)
    VALUES ('a','Current A','Current A','p','new-model','coder','prompt','2020','2021'),('b','B','B','p','model-b','','','2020','2020');
    INSERT INTO rooms (id,name,archived,created_at,updated_at) VALUES ('old','Old room',1,'2020','2021');
    INSERT INTO room_agents VALUES ('old','b',0),('old','a',1);
    INSERT INTO tasks (id,room_id,prompt,speaking_order,max_rounds,final_summarizer_id,status,created_at)
      VALUES ('legacy-task','old','constraint','["a"]',2,'a','completed','2020');
    INSERT INTO messages (id,room_id,role,content,created_at,task_id) VALUES ('u','old','user','Use sqlite only','2020','legacy-task');
    INSERT INTO messages (id,room_id,role,agent_id,agent_name,agent_avatar,model,content,created_at,task_id)
      VALUES ('a-msg','old','agent','a','Historical A','🦉','old-model','Agreed','2020','legacy-task');`);
  return db;
}
describe("legacy room canonical sessions", () => {
  it("upgrades real old schema preserving room/message IDs, member order, authors, archive and task links, idempotently", async () => {
    const db = oldDatabase(); runMigrations(db, migrations);
    const sessions = new SessionStore(db);
    expect(sessions.get("old")).toMatchObject({ id: "old", legacyRoomId: "old", kind: "chat", workspaceId: null, archived: true, primaryAgentId: "b", collaboration: { strategy: "single" } });
    expect(sessions.get("old")?.agents.map(a => a.agentId)).toEqual(["b", "a"]);
    expect(sessions.get("old")?.agents[1]?.snapshot).toMatchObject({ providerId: "p", systemPrompt: "prompt" });
    expect(sessions.listMessages("old").map(m => m.id)).toEqual(["u", "a-msg"]);
    expect(sessions.listMessages("old")[1]).toMatchObject({ role: "assistant", authorId: "a", runId: "legacy-task", authorSnapshot: { nickname: "Historical A", modelId: "old-model" } });
    expect(db.query("SELECT id FROM tasks WHERE id='legacy-task'").get()).not.toBeNull();
    expect(runMigrations(db, migrations)).toEqual([]);
    expect(sessions.list()).toHaveLength(1);
    expect(sessions.listMessages("old")).toHaveLength(2);
    const root = mkdtempSync(join(tmpdir(), "socrates-legacy-history-")); roots.push(root);
    const history = new HistoryStore(db, root); const canonical = new SessionStore(db, history);
    new ConversationMemoryStore(db, history);
    await history.bootstrapAll();
    expect(canonical.listMessages("old")).toHaveLength(2);
    await canonical.rewind("old", "a-msg");
    await new HistoryStore(db, root).bootstrapAll();
    expect(canonical.listMessages("old").map(m => m.id)).toEqual(["u"]);
    expect(db.query("SELECT id FROM messages WHERE id='a-msg'").get()).not.toBeNull();
    db.close();
  });
  it("keeps an existing stable legacy mapping and its native task/approval associations", () => {
    const db = oldDatabase(); runMigrations(db, migrations.filter(m => m.version < 22));
    const sessions = new SessionStore(db);
    sessions.create({ id: "mapped", title: "Already upgraded", kind: "chat", mode: "chat", legacyRoomId: "old", primaryAgentId: "a", agents: [{ agentId: "a", snapshot: { nickname: "Frozen" }, executionEligible: true }] });
    runMigrations(db, migrations);
    expect(sessions.get("old")).toBeNull();
    expect(sessions.get("mapped")?.agents[0]?.snapshot.nickname).toBe("Frozen");
    expect(sessions.listMessages("mapped").map(m => m.id)).toEqual(["u", "a-msg"]);
    expect(db.query("SELECT id FROM tasks WHERE id='legacy-task'").get()).not.toBeNull();
    db.close();
  });
});

it("canonical legacy room removal cannot reveal the source room again", async () => {
  const db = oldDatabase(); runMigrations(db, migrations);
  await new SessionStore(db).remove("old");
  expect(db.query("SELECT id FROM rooms WHERE id='old'").get()).toBeNull();
  expect(db.query("SELECT id FROM messages WHERE room_id='old'").get()).toBeNull();
  db.close();
});

it("marks old process-only tasks interrupted without changing durable task approvals", () => {
  const db = oldDatabase(); runMigrations(db, migrations.filter(m => m.version < 22));
  db.run("UPDATE tasks SET status='running' WHERE id='legacy-task'");
  new SessionStore(db).create({ id: "mapped", title: "Mapped", mode: "chat", legacyRoomId: "old", primaryAgentId: "a", agents: [{agentId: "a", snapshot: {}, executionEligible: true}] });
  db.exec(`INSERT INTO multi_tasks (id,session_id,prompt,state,config_json,created_at,updated_at) VALUES ('durable','mapped','existing','awaiting_plan_approval','{}','now','now');
    INSERT INTO approval_requests (id,task_id,kind,subject_id,input_hash,workspace_identity,attempt_id,policy_version,risk,fresh_human_required,status,created_at)
      VALUES ('approval','durable','plan','plan','hash','workspace','attempt',1,'low',1,'pending','now');`);
  runMigrations(db,migrations);
  expect(db.query("SELECT status,error FROM tasks WHERE id='legacy-task'").get()).toEqual({status: 'interrupted',error: 'interrupted_by_room_upgrade'});
  expect(db.query("SELECT state FROM multi_tasks WHERE id='durable'").get()).toEqual({state:'awaiting_plan_approval'});
  expect(db.query("SELECT status FROM approval_requests WHERE id='approval'").get()).toEqual({status:'pending'});
  db.close();
});

it("exports imported history into an existing mapped journal without losing prior native messages", async () => {
  const db = oldDatabase(); runMigrations(db, migrations.filter(m=>m.version<22));
  const root=mkdtempSync(join(tmpdir(),"socrates-mapped-history-"));roots.push(root);
  const history=new HistoryStore(db,root), sessions=new SessionStore(db,history), memory=new ConversationMemoryStore(db,history);
  sessions.create({id:'mapped',title:'Mapped',mode:'chat',legacyRoomId:'old',primaryAgentId:'a',agents:[{agentId:'a',snapshot:{},executionEligible:true}]});
  const thread=memory.ensureDefaultThread('mapped');
  await memory.appendMessage({messageId:'native-before',roomId:'mapped',threadId:thread.id,runId:null,turnId:null,agentId:null,role:'user',kind:'text',content:'Native history already journaled',parts:[],status:'completed',idempotencyKey:'native-before'});
  runMigrations(db,migrations); await history.bootstrapAll();
  expect(sessions.listMessages('mapped').map(message=>message.id)).toEqual(['native-before','u','a-msg']);
  const reopenedHistory=new HistoryStore(db,root); new SessionStore(db,reopenedHistory);new ConversationMemoryStore(db,reopenedHistory);
  await reopenedHistory.bootstrapAll();
  expect(sessions.listMessages('mapped').map(message=>message.id)).toEqual(['native-before','u','a-msg']);
  expect(reopenedHistory.status('mapped')?.status).toBe('ready');db.close();
});
