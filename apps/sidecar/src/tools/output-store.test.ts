import { expect, it } from "bun:test";
import { openDb } from "../db";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../store/migrations";
import { migrations } from "../store/migrations/index";
import { ToolOutputStore } from "./output-store";

const scope = { sessionId: "session", workspaceIdentity: "workspace" };
it("stores complete output and retrieves bounded pages without exposing another scope", () => {
  const db = openDb(":memory:"); const store = new ToolOutputStore(db);
  const ref = store.put(scope, "x".repeat(70_000));
  const page = store.read(scope, ref, 65_530, 20);
  expect(page).toMatchObject({ text: "x".repeat(20), byteSize: 70_000, nextOffset: 65_550, truncated: true });
  expect(() => store.read({ ...scope, sessionId: "other" }, ref)).toThrow("tool_output_not_found");
  expect(() => store.read(scope, "../../secret")).toThrow("invalid_tool_output_ref");
  expect(() => store.read(scope, ref, 0, 100_000)).toThrow("invalid_tool_output_range");
});

it("captures complete stdout and stderr in distinct durable artifacts", () => {
  const db = openDb(":memory:"); const store = new ToolOutputStore(db);
  const capture = store.createCommandCapture(scope, "operation");
  capture.write("stdout", new TextEncoder().encode("a".repeat(10_000)));
  capture.write("stdout", new TextEncoder().encode("tail"));
  capture.write("stderr", new TextEncoder().encode("diagnostic"));
  const refs = capture.finish();
  const reopened = new ToolOutputStore(db);
  expect(reopened.read(scope, refs.stdout, 10_000).text).toBe("tail");
  expect(reopened.read(scope, refs.stderr).text).toBe("diagnostic");
});

it("upgrades Phase4 storage and keeps legacy outputs and full artifacts across SQLite reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "tool-artifacts-upgrade-"));
  const path = join(root, "db.sqlite");
  let db = new Database(path);
  try {
    runMigrations(db, migrations.filter((migration) => migration.version <= 18));
    db.query(`INSERT INTO tool_calls (id,stable_key,session_id,task_id,attempt_id,turn_id,agent_id,name,generation,
      input_json,input_hash,workspace_identity,policy_version,risk,idempotency,status,created_at,updated_at)
      VALUES ('legacy','legacy','session','task','attempt','turn','agent','read_file',1,'{}','hash','workspace',1,'low','read','succeeded','now','now')`).run();
    db.query("INSERT INTO tool_outputs (tool_call_id,preview_text,byte_size,truncated,is_error) VALUES ('legacy','kept',4,0,0)").run();
    db.close();
    db = openDb(path);
    expect(db.query("SELECT preview_text, canonical_json FROM tool_outputs WHERE tool_call_id = 'legacy'").get())
      .toEqual({ preview_text: "kept", canonical_json: null });
    const original = "abc界😀".repeat(10_000);
    const ref = new ToolOutputStore(db).put(scope, original);
    db.close(); db = openDb(path);
    const store = new ToolOutputStore(db);
    let offset = 0; let text = "";
    do {
      const page = store.read(scope, ref, offset, 1027);
      expect(page.nextOffset).toBeGreaterThan(offset);
      text += page.text; offset = page.nextOffset;
      if (!page.truncated) break;
    } while (offset < Buffer.byteLength(original));
    expect(text).toBe(original);
    expect(() => store.read({ ...scope, workspaceIdentity: "other-workspace" }, ref)).toThrow("tool_output_not_found");
    expect(runMigrations(db, migrations)).toEqual([]);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

it("does not publish a partial artifact when persistence fails", () => {
  const db = openDb(":memory:");
  try {
    db.exec(`CREATE TRIGGER fail_capture BEFORE INSERT ON tool_result_chunks BEGIN SELECT RAISE(ABORT, 'disk_full'); END;`);
    expect(() => new ToolOutputStore(db).put(scope, "must not be lost silently")).toThrow("disk_full");
    expect(db.query("SELECT count(*) AS n FROM tool_result_artifacts").get()).toEqual({ n: 0 });
    expect(db.query("SELECT count(*) AS n FROM tool_result_chunks").get()).toEqual({ n: 0 });
  } finally { db.close(); }
});
