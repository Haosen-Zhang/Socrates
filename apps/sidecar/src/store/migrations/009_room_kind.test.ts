import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../migrations";
import { migrations } from "./index";

type SessionRow = { id: string; kind: string; workspace_id: string | null; recovery: string | null; mode: string };

/** 建一个跑到 008 为止的库，再插入 legacy 会话，最后单独跑 009。 */
function legacyDb(rows: Array<{ id: string; mode: string; workspaceId: string | null }>): Database {
  const db = new Database(":memory:");
  runMigrations(db, migrations.filter((m) => m.version <= 8));
  for (const row of rows) {
    db.run(
      `INSERT INTO sessions (id, title, mode, workspace_id, status, legacy_room_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'idle', NULL, 'now', 'now')`,
      [row.id, `session ${row.id}`, row.mode, row.workspaceId],
    );
    db.run(
      `INSERT INTO session_messages (id, session_id, role, author_id, content, status, created_at)
       VALUES (?, ?, 'user', NULL, 'hello', 'sent', 'now')`,
      [`msg-${row.id}`, row.id],
    );
  }
  return db;
}

const sessions = (db: Database) =>
  db.query<SessionRow, []>("SELECT id, kind, workspace_id, recovery, mode FROM sessions ORDER BY id").all();

describe("009 room_kind migration", () => {
  it("maps legacy modes to chat/cowork and preserves ids, messages and workspaces", () => {
    const db = legacyDb([
      { id: "s-chat", mode: "chat", workspaceId: null },
      { id: "s-single", mode: "single_agent", workspaceId: "ws-1" },
      { id: "s-multi", mode: "multi_agent", workspaceId: "ws-2" },
    ]);
    runMigrations(db, migrations);

    const rows = sessions(db);
    expect(rows.map((r) => [r.id, r.kind])).toEqual([
      ["s-chat", "chat"],
      ["s-multi", "cowork"],
      ["s-single", "cowork"],
    ]);
    // cowork 保留原 workspace，绝不换绑
    expect(rows.find((r) => r.id === "s-single")?.workspace_id).toBe("ws-1");
    expect(rows.find((r) => r.id === "s-multi")?.workspace_id).toBe("ws-2");
    // 历史消息不丢
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM session_messages").get()?.n).toBe(3);
  });

  it("strips any workspace a legacy chat had — chat never binds a workspace", () => {
    const db = legacyDb([{ id: "s-chat", mode: "chat", workspaceId: "ws-leaked" }]);
    runMigrations(db, migrations);
    const row = sessions(db)[0];
    expect(row.kind).toBe("chat");
    expect(row.workspace_id).toBeNull();
  });

  it("flags a workspace-less legacy agent session for recovery instead of auto-binding", () => {
    const db = legacyDb([
      { id: "s-orphan", mode: "single_agent", workspaceId: null },
      { id: "s-other", mode: "single_agent", workspaceId: "ws-recent" },
    ]);
    runMigrations(db, migrations);
    const orphan = sessions(db).find((r) => r.id === "s-orphan")!;
    expect(orphan.kind).toBe("cowork");
    expect(orphan.recovery).toBe("workspace_required");
    // 不得借用另一个会话的 workspace
    expect(orphan.workspace_id).toBeNull();
  });

  it("is idempotent — rerunning changes nothing and creates no duplicates", () => {
    const db = legacyDb([
      { id: "s-chat", mode: "chat", workspaceId: null },
      { id: "s-single", mode: "single_agent", workspaceId: "ws-1" },
    ]);
    runMigrations(db, migrations);
    const first = sessions(db);
    expect(runMigrations(db, migrations)).toEqual([]);
    expect(sessions(db)).toEqual(first);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM sessions").get()?.n).toBe(2);
  });

  it("records multi-agent collaboration intent for legacy multi_agent sessions", () => {
    const db = legacyDb([{ id: "s-multi", mode: "multi_agent", workspaceId: "ws-2" }]);
    runMigrations(db, migrations);
    const raw = db
      .query<{ collaboration_json: string | null }, []>("SELECT collaboration_json FROM sessions WHERE id = 's-multi'")
      .get();
    expect(JSON.parse(raw?.collaboration_json ?? "{}")).toMatchObject({
      discussion: { enabled: true, mode: "round_robin" },
    });
  });

  it("treats legacy group rooms as chat and clears any workspace on them", () => {
    const db = new Database(":memory:");
    runMigrations(db, migrations.filter((m) => m.version <= 8));
    db.run(
      `INSERT INTO rooms (id, name, archived, created_at, updated_at, workspace_id) VALUES ('r1','Legacy',0,'now','now','ws-x')`,
    );
    runMigrations(db, migrations);
    const room = db
      .query<{ kind: string; workspace_id: string | null }, []>("SELECT kind, workspace_id FROM rooms WHERE id='r1'")
      .get();
    expect(room?.kind).toBe("chat");
    expect(room?.workspace_id).toBeNull();
  });
});
