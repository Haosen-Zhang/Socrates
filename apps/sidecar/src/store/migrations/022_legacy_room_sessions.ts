import { toAgent, type AgentRow } from "../../agents";
import { migrationChecksum, type Migration } from "../migrations";

/** Sessions become the only writable room history. Legacy tables remain audit/task references. */
export const legacyRoomSessionsMigration: Migration = {
  version: 22, name: "legacy_rooms_canonical_sessions",
  checksum: migrationChecksum("022:legacy-rooms:same-id-or-existing-mapping:ordered-messages:immutable-author:archive:v1"),
  up(db) {
    // Legacy orchestration has no persisted runner to resume after a process
    // upgrade. Keep its audit records and make the interruption explicit.
    db.query("UPDATE tasks SET status = 'interrupted', error = COALESCE(error, 'interrupted_by_room_upgrade') WHERE status IN ('running', 'thinking')").run();
    const rooms = db.query<{ id: string; name: string; archived: number; created_at: string; updated_at: string }, []>("SELECT * FROM rooms ORDER BY created_at, rowid").all();
    for (const room of rooms) {
      const mapped = db.query<{ id: string }, [string]>("SELECT id FROM sessions WHERE legacy_room_id = ?").get(room.id);
      const sessionId = mapped?.id ?? room.id;
      if (!mapped) {
        if (db.query("SELECT id FROM sessions WHERE id = ?").get(sessionId)) throw new Error(`legacy_room_id_conflict:${sessionId}`);
        const members = db.query<{ agent_id: string; position: number }, [string]>("SELECT agent_id, position FROM room_agents WHERE room_id = ? ORDER BY position, agent_id").all(room.id);
        if (!members.length) {
          // A deleted template must not make old history inaccessible. This unavailable
          // member is repairable through the existing member editor, without inventing credentials.
          const author = db.query<{ agent_id: string }, [string]>("SELECT agent_id FROM messages WHERE room_id = ? AND agent_id IS NOT NULL ORDER BY rowid LIMIT 1").get(room.id);
          members.push({ agent_id: author?.agent_id ?? `legacy-unavailable:${room.id}`, position: 0 });
        }
        db.query(`INSERT INTO sessions (id,title,mode,kind,workspace_id,primary_agent_id,archived,status,legacy_room_id,created_at,updated_at)
          VALUES (?,?,'chat','chat',NULL,?,?,'idle',?,?,?)`).run(sessionId, room.name, members[0]!.agent_id, room.archived, room.id, room.created_at, room.updated_at);
        for (const member of members) {
          const agent = db.query<AgentRow, [string]>("SELECT * FROM agents WHERE id = ?").get(member.agent_id);
          const snapshot = agent ? toAgent(agent) : { id: member.agent_id, nickname: "Unavailable legacy member", providerId: "", modelId: "", systemPrompt: "" };
          db.query("INSERT INTO session_agents (session_id,agent_id,snapshot_json,position,execution_eligible) VALUES (?,?,?,?,?)")
            .run(sessionId, member.agent_id, JSON.stringify(snapshot), member.position, agent ? 1 : 0);
        }
      }
      let thread = db.query<{ id: string; latest_sequence: number }, [string]>("SELECT id, latest_sequence FROM conversation_threads WHERE room_id = ? AND is_default = 1").get(sessionId);
      if (!thread) {
        thread = { id: `thread:${sessionId}`, latest_sequence: 0 };
        db.query("INSERT INTO conversation_threads (id,room_id,is_default,latest_sequence,created_at,updated_at) VALUES (?,?,1,0,?,?)")
          .run(thread.id, sessionId, room.created_at, room.updated_at);
      }
      let sequence = Math.max(thread.latest_sequence,
        db.query<{ n: number }, [string]>("SELECT COALESCE(MAX(sequence),0) n FROM session_messages WHERE session_id = ?").get(sessionId)!.n,
        db.query<{ projected_sequence: number }, [string]>("SELECT projected_sequence FROM history_projection_state WHERE session_id = ?").get(sessionId)?.projected_sequence ?? 0);
      const messages = db.query<{ id: string; role: string; agent_id: string | null; content: string; created_at: string; task_id: string | null }, [string]>("SELECT * FROM messages WHERE room_id = ? ORDER BY rowid").all(room.id);
      for (const message of messages) {
        const existing = db.query<{ session_id: string }, [string]>("SELECT session_id FROM session_messages WHERE id = ?").get(message.id);
        if (existing) {
          if (existing.session_id !== sessionId) throw new Error(`legacy_message_id_conflict:${message.id}`);
          continue;
        }
        db.query(`INSERT INTO session_messages
          (id,session_id,thread_id,role,author_id,agent_id,content,status,created_at,run_id,kind,sequence,idempotency_key)
          VALUES (?,?,?,?,?,?,?,'completed',?,?,'text',?,?)`)
          .run(message.id, sessionId, thread.id, message.role === "agent" ? "assistant" : message.role,
            message.agent_id, message.agent_id, message.content, message.created_at, message.task_id, ++sequence, `legacy-room:${message.id}`);
        db.query("INSERT INTO message_parts (id,message_id,ordinal,type,text) VALUES (?,?,0,'text',?)")
          .run(`legacy-part:${message.id}`, message.id, message.content);
      }
      db.query("UPDATE conversation_threads SET latest_sequence = ? WHERE id = ?").run(sequence, thread.id);
      // Keep one usage record; both legacy and canonical room queries can address it.
      db.query("UPDATE usage_records SET session_id = ? WHERE room_id = ? AND session_id IS NULL").run(sessionId, room.id);
    }
  },
};
