import type { Migration } from "../migrations";
import { ensureColumns, migrationChecksum } from "../migrations";

export const conversationMemoryMigration: Migration = {
  version: 11,
  name: "durable_conversation_memory",
  checksum: migrationChecksum("011:conversation-memory:v2:threads-turns-message-metadata-primary-agent-input-hash"),
  up(db) {
    ensureColumns(db, "sessions", ["primary_agent_id TEXT"]);
    ensureColumns(db, "agent_runs", ["attempt_no INTEGER NOT NULL DEFAULT 1"]);
    ensureColumns(db, "session_messages", [
      "thread_id TEXT",
      "run_id TEXT",
      "turn_id TEXT",
      "agent_id TEXT",
      "kind TEXT",
      "sequence INTEGER",
      "idempotency_key TEXT",
    ]);

    db.exec(`
      CREATE TABLE conversation_threads (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        latest_sequence INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (room_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX idx_conversation_threads_default
        ON conversation_threads (room_id) WHERE is_default = 1;
      CREATE INDEX idx_conversation_threads_room ON conversation_threads (room_id, updated_at);

      CREATE TABLE conversation_turns (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        client_turn_key TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        run_id TEXT,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_no INTEGER NOT NULL DEFAULT 1,
        context_truncated INTEGER NOT NULL DEFAULT 0,
        context_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE (thread_id, client_turn_key),
        FOREIGN KEY (room_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (thread_id) REFERENCES conversation_threads(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_conversation_turns_thread
        ON conversation_turns (thread_id, created_at);

      CREATE UNIQUE INDEX idx_session_messages_thread_sequence
        ON session_messages (thread_id, sequence)
        WHERE thread_id IS NOT NULL AND sequence IS NOT NULL;
      CREATE UNIQUE INDEX idx_session_messages_idempotency
        ON session_messages (thread_id, idempotency_key)
        WHERE thread_id IS NOT NULL AND idempotency_key IS NOT NULL;
      CREATE INDEX idx_session_messages_thread
        ON session_messages (thread_id, sequence);
    `);

    db.exec(`
      UPDATE sessions
      SET primary_agent_id = (
        SELECT agent_id
        FROM session_agents
        WHERE session_agents.session_id = sessions.id
        ORDER BY execution_eligible DESC, position, agent_id
        LIMIT 1
      )
      WHERE primary_agent_id IS NULL;
    `);

    const now = new Date().toISOString();
    db.query(`
      INSERT INTO conversation_threads
        (id, room_id, is_default, latest_sequence, created_at, updated_at)
      SELECT 'thread:' || id, id, 1, 0, created_at, updated_at
      FROM sessions
    `).run();

    const rows = db.query<{
      id: string;
      session_id: string;
      role: string;
      author_id: string | null;
    }, []>(`
      SELECT id, session_id, role, author_id
      FROM session_messages
      ORDER BY session_id, created_at, rowid
    `).all();
    const nextByRoom = new Map<string, number>();
    const updateMessage = db.query(`
      UPDATE session_messages
      SET thread_id = ?, agent_id = ?, kind = ?, sequence = ?, idempotency_key = ?
      WHERE id = ?
    `);
    for (const row of rows) {
      const sequence = (nextByRoom.get(row.session_id) ?? 0) + 1;
      nextByRoom.set(row.session_id, sequence);
      updateMessage.run(
        `thread:${row.session_id}`,
        row.author_id,
        row.role === "tool" ? "tool_result" : "text",
        sequence,
        `legacy:${row.id}`,
        row.id,
      );
    }
    const updateThread = db.query("UPDATE conversation_threads SET latest_sequence = ?, updated_at = ? WHERE room_id = ?");
    for (const [roomId, latest] of nextByRoom) updateThread.run(latest, now, roomId);

    db.exec(`
      UPDATE agent_runs
      SET thread_id = COALESCE(thread_id, 'thread:' || session_id),
          turn_id = COALESCE(turn_id, 'turn:legacy:' || id)
      WHERE thread_id IS NULL OR turn_id IS NULL;
    `);
  },
};
