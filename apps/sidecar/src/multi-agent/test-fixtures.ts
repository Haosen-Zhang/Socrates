import { openDb } from "../db";
import { teamWorkPackagesMigration } from "../store/migrations/021_team_work_packages";
import { WorkPackageStore } from "./work-package-store";

export function packageSetup() {
  const db = openDb(":memory:");
  if (!db.query("SELECT name FROM sqlite_master WHERE name = 'work_packages'").get()) teamWorkPackagesMigration.up(db);
  db.exec(`INSERT INTO workspaces (id,canonical_path,display_path,identity_hash,label,created_at,last_opened_at) VALUES ('w','/tmp','/tmp','hash','tmp','now','now');
    INSERT INTO sessions (id,title,mode,kind,workspace_id,status,created_at,updated_at) VALUES ('s','Team','multi_agent','cowork','w','idle','now','now');
    INSERT INTO multi_tasks (id,session_id,prompt,state,attempt_no,config_json,created_at,updated_at) VALUES ('t','s','build','executing',1,'{}','now','now');`);
  for (const id of ["a", "b"]) db.query("INSERT INTO session_agents (session_id,agent_id,snapshot_json,position,execution_eligible) VALUES ('s',?,'{}',?,1)").run(id, id === "a" ? 0 : 1);
  const store = new WorkPackageStore(db);
  const definitions = [
    { id: "first", title: "First", objective: "write first", input: "first input", dependencies: [], executorAgentId: "a", reviewerAgentId: null, expectedFiles: ["one.ts"], acceptanceCriteria: ["one passes"] },
    { id: "second", title: "Second", objective: "write second", input: "second input", dependencies: ["first"], executorAgentId: "b", reviewerAgentId: null, expectedFiles: ["two.ts"], acceptanceCriteria: ["two passes"] },
  ];
  return { db, store, definitions };
}
