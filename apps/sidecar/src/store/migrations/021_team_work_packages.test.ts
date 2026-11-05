import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { migrations } from "./index";
import { runMigrations } from "../migrations";
import { teamWorkPackagesMigration } from "./021_team_work_packages";

describe("team package migration", () => {
  it("preserves legacy room ids, messages and role snapshots", () => {
    const db = new Database(":memory:");
    const previous = migrations.filter((m) => m.version < 21);
    runMigrations(db, previous);
    db.exec("INSERT INTO rooms (id,name,created_at,updated_at) VALUES ('legacy-chat','history','now','now')");
    db.exec("INSERT INTO sessions (id,title,mode,kind,workspace_id,status,created_at,updated_at) VALUES ('legacy','old chat','chat','chat',NULL,'idle','now','now')");
    db.exec("INSERT INTO session_agents (session_id,agent_id,snapshot_json,position,execution_eligible) VALUES ('legacy','member','{\"modelId\":\"original\"}',0,0)");
    db.exec("INSERT INTO session_messages (id,session_id,role,author_id,content,status,created_at) VALUES ('m','legacy','assistant','member','history','completed','now')");
    expect(runMigrations(db, [...previous, teamWorkPackagesMigration])).toEqual([21]);
    expect(db.query("SELECT id,name FROM rooms").get()).toEqual({ id: "legacy-chat", name: "history" });
    expect(db.query("SELECT id,author_id,content FROM session_messages").get()).toEqual({ id: "m", author_id: "member", content: "history" });
    expect(db.query("SELECT snapshot_json FROM session_agents").get()).toEqual({ snapshot_json: '{"modelId":"original"}' });
    expect(db.query("SELECT COUNT(*) AS n FROM work_packages").get()).toEqual({ n: 0 });
    expect(runMigrations(db, [...previous, teamWorkPackagesMigration])).toEqual([]);
  });
});
