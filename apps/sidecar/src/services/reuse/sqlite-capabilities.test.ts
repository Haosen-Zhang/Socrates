import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

test("bundled Bun SQLite supports the FTS5 retrieval seam without external infrastructure", () => {
  const db = new Database(":memory:");
  db.exec("CREATE VIRTUAL TABLE fixture_memory USING fts5(project_id UNINDEXED, body)");
  db.query("INSERT INTO fixture_memory(project_id,body) VALUES (?,?)").run("project-a", "preserve backwards compatible APIs");
  db.query("INSERT INTO fixture_memory(project_id,body) VALUES (?,?)").run("project-b", "private backwards compatible APIs");
  const matches = db.query<{ body: string }, [string, string]>("SELECT body FROM fixture_memory WHERE fixture_memory MATCH ? AND project_id=?").all("compatible", "project-a");
  expect(matches).toEqual([{ body: "preserve backwards compatible APIs" }]);
  db.close();
});
