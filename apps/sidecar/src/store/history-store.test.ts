import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db";
import { SessionStore } from "./session-store";
import { HistoryStore } from "./history-store";

function fixture() {
  const db = openDb(":memory:");
  db.query(`INSERT INTO workspaces
    (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at)
    VALUES ('workspace', '/tmp/history-workspace', '/tmp/history-workspace', 'history-hash', 'History', 'now', 'now')`).run();
  const sessions = new SessionStore(db);
  const session = sessions.create({
    title: "History", mode: "single_agent", workspaceId: "workspace", primaryAgentId: "agent",
    agents: [{ agentId: "agent", snapshot: {}, executionEligible: true }],
  });
  db.query(`INSERT INTO conversation_threads
    (id, room_id, is_default, latest_sequence, created_at, updated_at)
    VALUES (?, ?, 1, 0, 'now', 'now')`).run(`thread:${session.id}`, session.id);
  const dir = mkdtempSync(join(tmpdir(), "socrates-history-"));
  return { db, session, dir, history: new HistoryStore(db, dir) };
}

describe("HistoryStore", () => {
  it("serializes strict hash-chained records and deduplicates record IDs", async () => {
    const f = fixture();
    try {
      await f.history.bootstrapSession(f.session.id);
      const input = {
        recordId: "turn:user:1", roomId: f.session.id, threadId: `thread:${f.session.id}`,
        runId: "run", turnId: "turn", agentId: "agent", role: "user" as const,
        kind: "text" as const, content: "hello", parts: [{ type: "text" as const, text: "hello" }],
        status: "completed", idempotencyKey: "turn:user:1",
      };
      const first = await f.history.appendMessage(input);
      const duplicate = await f.history.appendMessage(input);
      const second = await f.history.appendMessage({ ...input, messageId: "assistant", role: "assistant", content: "world", idempotencyKey: "turn:assistant:1" });
      expect(duplicate.recordHash).toBe(first.recordHash);
      expect(second.sequence).toBe(first.sequence + 1);
      expect(second.previousHash).toBe(first.recordHash);
      expect(readFileSync(f.history.roomPath(f.session.id), "utf8").trim().split("\n")).toHaveLength(2);
      await expect(f.history.appendMessage({ ...input, content: "conflict" })).rejects.toThrow("history_idempotency_conflict");
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("preserves invocation order for concurrent appends in one Session queue", async () => {
    const f = fixture();
    try {
      const records = await Promise.all(Array.from({ length: 12 }, (_, index) => f.history.appendMessage({
        messageId: `message-${index}`, roomId: f.session.id, threadId: `thread:${f.session.id}`,
        runId: null, turnId: null, agentId: "agent", role: "user", kind: "text", content: `message-${index}`,
        parts: [], status: "completed", idempotencyKey: `queue:${index}`,
      })));
      expect(records.map((record) => record.sequence)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
      expect(records.slice(1).every((record, index) => record.previousHash === records[index]?.recordHash)).toBe(true);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("lazily initializes a newly created Session before its first append", async () => {
    const f = fixture();
    try {
      const record = await f.history.appendMessage({
        messageId: "first", roomId: f.session.id, threadId: `thread:${f.session.id}`,
        runId: null, turnId: null, agentId: "agent", role: "user", kind: "text", content: "first",
        parts: [], status: "completed", idempotencyKey: "first:key",
      });
      expect(record.sequence).toBe(1);
      expect(f.history.status(f.session.id)?.status).toBe("ready");
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("scopes idempotency keys to their Session", async () => {
    const f = fixture();
    try {
      const second = new SessionStore(f.db).create({
        title: "Second", mode: "single_agent", workspaceId: "workspace", primaryAgentId: "agent",
        agents: [{ agentId: "agent", snapshot: {}, executionEligible: true }],
      });
      const common = {
        runId: null, turnId: null, agentId: "agent", role: "user" as const, kind: "text" as const,
        parts: [], status: "completed", idempotencyKey: "same:key",
      };
      const firstRecord = await f.history.appendMessage({
        ...common, messageId: "first", roomId: f.session.id, threadId: `thread:${f.session.id}`, content: "first",
      });
      const secondRecord = await f.history.appendMessage({
        ...common, messageId: "second", roomId: second.id, threadId: `thread:${second.id}`, content: "second",
      });
      expect(firstRecord.recordId).toBe(secondRecord.recordId);
      expect(f.db.query<{ session_id: string }, [string]>(
        "SELECT session_id FROM history_projection_records WHERE record_id = ? ORDER BY session_id",
      ).all("same:key").map((row) => row.session_id)).toEqual([f.session.id, second.id].sort());
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("exports existing SQLite messages before changing authority", async () => {
    const f = fixture();
    try {
      f.db.query(`INSERT INTO session_messages
        (id, session_id, thread_id, role, kind, content, sequence, status, idempotency_key, created_at)
        VALUES ('legacy', ?, ?, 'user', 'text', 'kept', 1, 'completed', 'legacy:key', 'now')`)
        .run(f.session.id, `thread:${f.session.id}`);
      f.db.query("UPDATE conversation_threads SET latest_sequence = 1 WHERE room_id = ?").run(f.session.id);
      await f.history.bootstrapSession(f.session.id);
      const line = JSON.parse(readFileSync(f.history.roomPath(f.session.id), "utf8"));
      expect(line).toMatchObject({ recordId: "legacy:key", content: "kept", sequence: 1 });
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("continues an interrupted legacy export without dropping unexported messages", async () => {
    const f = fixture();
    try {
      const threadId = `thread:${f.session.id}`;
      f.db.query(`INSERT INTO session_messages
        (id, session_id, thread_id, role, kind, content, sequence, status, idempotency_key, created_at)
        VALUES (?, ?, ?, 'user', 'text', ?, ?, 'completed', ?, 'now')`)
        .run("legacy-1", f.session.id, threadId, "first", 1, "legacy:1");
      f.db.query(`INSERT INTO session_messages
        (id, session_id, thread_id, role, kind, content, sequence, status, idempotency_key, created_at)
        VALUES (?, ?, ?, 'assistant', 'text', ?, ?, 'completed', ?, 'now')`)
        .run("legacy-2", f.session.id, threadId, "second", 2, "legacy:2");
      await f.history.bootstrapSession(f.session.id);
      const lines = readFileSync(f.history.roomPath(f.session.id), "utf8").trim().split("\n");
      const first = JSON.parse(lines[0]!) as { recordHash: string };
      const firstLength = Buffer.byteLength(`${lines[0]}\n`);
      truncateSync(f.history.roomPath(f.session.id), firstLength);
      f.db.query("DELETE FROM history_projection_records WHERE session_id = ? AND record_id = 'legacy:2'").run(f.session.id);
      f.db.query(`UPDATE history_projection_state SET projected_offset = ?, projected_sequence = 1, last_hash = ?
        WHERE session_id = ?`).run(firstLength, first.recordHash, f.session.id);

      await new HistoryStore(f.db, f.dir).bootstrapSession(f.session.id);
      expect(readFileSync(f.history.roomPath(f.session.id), "utf8").trim().split("\n")).toHaveLength(2);
      expect(f.db.query("SELECT content FROM session_messages WHERE session_id = ? ORDER BY sequence").all(f.session.id))
        .toEqual([{ content: "first" }, { content: "second" }]);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("keeps a rewound legacy message inactive after rebuilding the SQLite projection", async () => {
    const f = fixture();
    try {
      const threadId = `thread:${f.session.id}`;
      f.db.query(`INSERT INTO session_messages
        (id, session_id, thread_id, role, kind, content, sequence, status, idempotency_key, created_at)
        VALUES ('legacy', ?, ?, 'user', 'text', 'legacy', 1, 'completed', NULL, 'now')`)
        .run(f.session.id, threadId);
      await f.history.bootstrapSession(f.session.id);
      await f.history.rewind(f.session.id, threadId, 1);
      expect(f.db.query("SELECT id FROM session_messages WHERE id = 'legacy'").get()).toBeNull();
      f.db.query("DELETE FROM session_messages WHERE session_id = ?").run(f.session.id);
      await f.history.reconcile(f.session.id);
      expect(f.db.query("SELECT id FROM session_messages WHERE id = 'legacy'").get()).toBeNull();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("repairs a final partial line and replays a committed unprojected record", async () => {
    const f = fixture();
    try {
      await f.history.bootstrapSession(f.session.id);
      await f.history.appendMessage({
        messageId: "message", roomId: f.session.id, threadId: `thread:${f.session.id}`,
        runId: null, turnId: null, agentId: "agent", role: "user", kind: "text", content: "durable",
        parts: [], status: "completed", idempotencyKey: "durable:key",
      });
      f.db.query("DELETE FROM history_projection_records WHERE record_id = 'durable:key'").run();
      f.db.query("DELETE FROM session_messages WHERE id = 'message'").run();
      appendFileSync(f.history.roomPath(f.session.id), "{partial");
      await f.history.reconcile(f.session.id);
      expect(f.db.query("SELECT content FROM session_messages WHERE id = 'message'").get()).toEqual({ content: "durable" });
      expect(readFileSync(f.history.roomPath(f.session.id), "utf8")).toEndWith("\n");
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("replays a durable record after the SQLite projection fails", async () => {
    const f = fixture();
    try {
      await f.history.bootstrapSession(f.session.id);
      f.db.exec(`CREATE TRIGGER fail_history_projection BEFORE INSERT ON history_projection_records
        BEGIN SELECT RAISE(ABORT, 'injected_projection_failure'); END`);
      await expect(f.history.appendMessage({
        messageId: "message", roomId: f.session.id, threadId: `thread:${f.session.id}`,
        runId: null, turnId: null, agentId: "agent", role: "user", kind: "text", content: "journal wins",
        parts: [{ type: "text", text: "journal wins" }], status: "completed", idempotencyKey: "projection:key",
      })).rejects.toThrow("injected_projection_failure");
      expect(readFileSync(f.history.roomPath(f.session.id), "utf8")).toContain("journal wins");
      expect(f.db.query("SELECT id FROM session_messages WHERE id = 'message'").get()).toBeNull();

      f.db.exec("DROP TRIGGER fail_history_projection");
      await f.history.reconcile(f.session.id);
      expect(f.db.query("SELECT content FROM session_messages WHERE id = 'message'").get()).toEqual({ content: "journal wins" });
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("appends rewind epochs without deleting journal history", async () => {
    const f = fixture();
    try {
      await f.history.bootstrapSession(f.session.id);
      const threadId = `thread:${f.session.id}`;
      await f.history.appendMessage({
        messageId: "first", roomId: f.session.id, threadId, runId: null, turnId: null, agentId: "agent",
        role: "user", kind: "text", content: "first", parts: [], status: "completed", idempotencyKey: "first:key",
      });
      await f.history.appendMessage({
        messageId: "second", roomId: f.session.id, threadId, runId: null, turnId: null, agentId: "agent",
        role: "assistant", kind: "text", content: "second", parts: [], status: "completed", idempotencyKey: "second:key",
      });

      const rewind = await f.history.rewind(f.session.id, threadId, 2);
      expect(rewind).toMatchObject({ kind: "rewind", epoch: 0, rewind: { targetSequence: 2, nextEpoch: 1 } });
      expect(readFileSync(f.history.roomPath(f.session.id), "utf8").trim().split("\n")).toHaveLength(3);
      expect(f.db.query("SELECT id FROM session_messages ORDER BY sequence").all()).toEqual([{ id: "first" }]);

      const resumed = await f.history.appendMessage({
        messageId: "third", roomId: f.session.id, threadId, runId: null, turnId: null, agentId: "agent",
        role: "user", kind: "text", content: "third", parts: [], status: "completed", idempotencyKey: "third:key",
      });
      expect(resumed.epoch).toBe(1);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("rewinds only the selected Thread projection", async () => {
    const f = fixture();
    try {
      const firstThread = `thread:${f.session.id}`;
      const secondThread = `thread:second:${f.session.id}`;
      f.db.query(`INSERT INTO conversation_threads
        (id, room_id, is_default, latest_sequence, created_at, updated_at)
        VALUES (?, ?, 0, 0, 'now', 'now')`).run(secondThread, f.session.id);
      for (const [messageId, threadId] of [["first", firstThread], ["second", firstThread], ["other", secondThread]] as const) {
        await f.history.appendMessage({
          messageId, roomId: f.session.id, threadId, runId: null, turnId: null, agentId: "agent",
          role: "user", kind: "text", content: messageId, parts: [], status: "completed", idempotencyKey: `${messageId}:key`,
        });
      }
      await f.history.rewind(f.session.id, firstThread, 2);
      expect(f.db.query("SELECT id FROM session_messages ORDER BY id").all()).toEqual([{ id: "first" }, { id: "other" }]);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("replays rewind cleanup after a sidecar restart", async () => {
    const f = fixture();
    try {
      const threadId = `thread:${f.session.id}`;
      for (const messageId of ["first", "second"]) {
        await f.history.appendMessage({
          messageId, roomId: f.session.id, threadId, runId: null, turnId: null, agentId: "agent",
          role: "user", kind: "text", content: messageId, parts: [], status: "completed",
          idempotencyKey: `${messageId}:key`,
        });
      }
      const sessions = new SessionStore(f.db, f.history);
      f.db.exec(`CREATE TRIGGER fail_rewind_projection BEFORE UPDATE ON sessions
        WHEN NEW.status = 'idle' BEGIN SELECT RAISE(ABORT, 'injected_rewind_projection_failure'); END`);
      await expect(sessions.rewind(f.session.id, "second")).rejects.toThrow("injected_rewind_projection_failure");
      f.db.exec("DROP TRIGGER fail_rewind_projection");

      const restartedHistory = new HistoryStore(f.db, f.dir);
      new SessionStore(f.db, restartedHistory);
      await restartedHistory.bootstrapSession(f.session.id);
      expect(f.db.query("SELECT id FROM session_messages ORDER BY sequence").all()).toEqual([{ id: "first" }]);
      expect(new SessionStore(f.db).get(f.session.id)?.status).toBe("idle");
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("removes the local journal when its Session is deleted", async () => {
    const f = fixture();
    try {
      await f.history.bootstrapSession(f.session.id);
      await f.history.appendMessage({
        messageId: "message", roomId: f.session.id, threadId: `thread:${f.session.id}`,
        runId: null, turnId: null, agentId: "agent", role: "user", kind: "text", content: "delete",
        parts: [], status: "completed", idempotencyKey: "delete:key",
      });
      expect(existsSync(f.history.roomPath(f.session.id))).toBe(true);
      await new SessionStore(f.db, f.history).remove(f.session.id);
      expect(existsSync(f.history.roomPath(f.session.id))).toBe(false);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("restores a staged journal when the SQLite deletion rolls back", async () => {
    const f = fixture();
    try {
      await f.history.appendMessage({
        messageId: "message", roomId: f.session.id, threadId: `thread:${f.session.id}`,
        runId: null, turnId: null, agentId: "agent", role: "user", kind: "text", content: "keep",
        parts: [], status: "completed", idempotencyKey: "keep:key",
      });
      await expect(new SessionStore(f.db, f.history).remove(f.session.id, () => {
        throw new Error("injected_delete_failure");
      })).rejects.toThrow("injected_delete_failure");
      expect(existsSync(f.history.roomPath(f.session.id))).toBe(true);
      expect(new SessionStore(f.db).get(f.session.id)).not.toBeNull();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("recovers a staged deletion after a process interruption", async () => {
    const f = fixture();
    try {
      await f.history.appendMessage({
        messageId: "message", roomId: f.session.id, threadId: `thread:${f.session.id}`,
        runId: null, turnId: null, agentId: "agent", role: "user", kind: "text", content: "keep",
        parts: [], status: "completed", idempotencyKey: "keep:key",
      });
      await f.history.stageSessionDeletion(f.session.id);
      expect(existsSync(f.history.roomPath(f.session.id))).toBe(false);
      await new HistoryStore(f.db, f.dir).bootstrapAll();
      expect(existsSync(f.history.roomPath(f.session.id))).toBe(true);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("clears a live deletion marker left before the staging rename", async () => {
    const f = fixture();
    try {
      await f.history.appendMessage({
        messageId: "message", roomId: f.session.id, threadId: `thread:${f.session.id}`,
        runId: null, turnId: null, agentId: "agent", role: "user", kind: "text", content: "keep",
        parts: [], status: "completed", idempotencyKey: "keep:key",
      });
      const marker = join(f.dir, f.session.id, ".deletion.json");
      writeFileSync(marker, JSON.stringify({ sessionId: f.session.id }));
      await new HistoryStore(f.db, f.dir).bootstrapAll();
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(f.history.roomPath(f.session.id))).toBe(true);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("rejects an unsequenced legacy rewind when HistoryStore is authoritative", async () => {
    const f = fixture();
    try {
      f.db.query(`INSERT INTO session_messages
        (id, session_id, role, content, status, created_at)
        VALUES ('legacy-unsequenced', ?, 'user', 'legacy', 'completed', 'now')`).run(f.session.id);
      await expect(new SessionStore(f.db, f.history).rewind(f.session.id, "legacy-unsequenced"))
        .rejects.toThrow("history_legacy_rewind_unsupported");
      expect(f.db.query("SELECT id FROM session_messages WHERE id = 'legacy-unsequenced'").get())
        .toEqual({ id: "legacy-unsequenced" });
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("enters read-only recovery for a complete hash-corrupt record", async () => {
    const f = fixture();
    try {
      await f.history.bootstrapSession(f.session.id);
      writeFileSync(f.history.roomPath(f.session.id), `${JSON.stringify({ schemaVersion: 1, recordId: "bad", previousHash: null, recordHash: "bad" })}\n`);
      await expect(f.history.reconcile(f.session.id)).rejects.toThrow("history_read_only_recovery");
      expect(f.history.status(f.session.id)).toMatchObject({ status: "recovery", error: "history_hash_mismatch" });
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("rejects a hash-valid record with a non-contiguous sequence", async () => {
    const f = fixture();
    try {
      await f.history.appendMessage({
        messageId: "message", roomId: f.session.id, threadId: `thread:${f.session.id}`,
        runId: null, turnId: null, agentId: "agent", role: "user", kind: "text", content: "sequence",
        parts: [], status: "completed", idempotencyKey: "sequence:key",
      });
      const record = JSON.parse(readFileSync(f.history.roomPath(f.session.id), "utf8"));
      record.sequence = 2;
      const { recordHash: _recordHash, ...unsigned } = record;
      record.recordHash = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
      writeFileSync(f.history.roomPath(f.session.id), `${JSON.stringify(record)}\n`);
      await expect(f.history.reconcile(f.session.id)).rejects.toThrow("history_read_only_recovery");
      expect(f.history.status(f.session.id)?.error).toBe("history_sequence_gap");
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("enters recovery when the journal loses a committed complete tail", async () => {
    const f = fixture();
    try {
      await f.history.bootstrapSession(f.session.id);
      await f.history.appendMessage({
        messageId: "first", roomId: f.session.id, threadId: `thread:${f.session.id}`,
        runId: null, turnId: null, agentId: "agent", role: "user", kind: "text", content: "first",
        parts: [], status: "completed", idempotencyKey: "first:key",
      });
      await f.history.appendMessage({
        messageId: "second", roomId: f.session.id, threadId: `thread:${f.session.id}`,
        runId: null, turnId: null, agentId: "agent", role: "assistant", kind: "text", content: "second",
        parts: [], status: "completed", idempotencyKey: "second:key",
      });
      const firstLineLength = Buffer.byteLength(`${readFileSync(f.history.roomPath(f.session.id), "utf8").split("\n")[0]}\n`);
      truncateSync(f.history.roomPath(f.session.id), firstLineLength);

      await expect(f.history.reconcile(f.session.id)).rejects.toThrow("history_read_only_recovery");
      expect(f.history.status(f.session.id)?.error).toBe("history_projection_checkpoint_missing");
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("enters recovery when a committed journal is missing", async () => {
    const f = fixture();
    try {
      await f.history.appendMessage({
        messageId: "message", roomId: f.session.id, threadId: `thread:${f.session.id}`,
        runId: null, turnId: null, agentId: "agent", role: "user", kind: "text", content: "missing",
        parts: [], status: "completed", idempotencyKey: "missing:key",
      });
      rmSync(f.history.roomPath(f.session.id));
      await expect(new HistoryStore(f.db, f.dir).bootstrapSession(f.session.id)).rejects.toThrow("history_read_only_recovery");
      expect(f.history.status(f.session.id)?.error).toBe("history_projection_checkpoint_missing");
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("keeps booting healthy Sessions when another journal is corrupt", async () => {
    const f = fixture();
    try {
      const second = new SessionStore(f.db).create({
        title: "Healthy", mode: "single_agent", workspaceId: "workspace", primaryAgentId: "agent",
        agents: [{ agentId: "agent", snapshot: {}, executionEligible: true }],
      });
      await f.history.bootstrapAll();
      writeFileSync(f.history.roomPath(f.session.id), `${JSON.stringify({ schemaVersion: 1, recordId: "bad", previousHash: null, recordHash: "bad" })}\n`);

      await expect(f.history.bootstrapAll()).resolves.toBeUndefined();
      expect(f.history.status(f.session.id)?.status).toBe("recovery");
      expect(f.history.status(second.id)?.status).toBe("ready");
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});
