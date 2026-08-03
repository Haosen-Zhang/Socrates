import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fdatasyncSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppendMessageInput, HistoryRecord, MessagePart } from "@socrates/core";

type ProjectionState = {
  session_id: string; projected_offset: number; projected_sequence: number;
  current_epoch: number; last_hash: string | null; status: string;
};

export type HistoryAppendInput = Omit<HistoryRecord, "schemaVersion" | "sequence" | "epoch" | "previousHash" | "recordHash">;

export class HistoryStore {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly projectionHandlers = new Map<string, (record: HistoryRecord) => void>();

  constructor(private readonly db: Database, private readonly historyDir: string) {}

  registerProjectionHandler(type: string, handler: (record: HistoryRecord) => void): void {
    this.projectionHandlers.set(type, handler);
  }

  async bootstrapAll(): Promise<void> {
    this.recoverStagedDeletions();
    const sessions = this.db.query<{ id: string }, []>("SELECT id FROM sessions ORDER BY created_at").all();
    for (const session of sessions) {
      try {
        await this.bootstrapSession(session.id);
      } catch (error) {
        // A corrupt journal isolates that Session in read-only recovery; it must
        // not prevent unrelated Sessions or the sidecar itself from starting.
        if (!(error instanceof Error) || error.message !== "history_read_only_recovery") throw error;
      }
    }
  }

  async bootstrapSession(sessionId: string): Promise<void> {
    await this.inSessionQueue(sessionId, async () => {
      this.bootstrapUnlocked(sessionId);
    });
  }

  async append(input: HistoryAppendInput, projectionEffect?: () => void): Promise<HistoryRecord> {
    return this.inSessionQueue(input.sessionId, async () => this.appendUnlocked(input, projectionEffect));
  }

  private appendUnlocked(input: HistoryAppendInput, projectionEffect?: () => void): HistoryRecord {
      this.ensureReady(input.sessionId);
      const existing = this.db.query<{ record_id: string }, [string, string]>(
        "SELECT record_id FROM history_projection_records WHERE session_id = ? AND record_id = ?",
      ).get(input.sessionId, input.recordId);
      if (existing) {
        const record = this.readRecord(input.sessionId, input.recordId);
        assertCompatibleRecord(record, input);
        if (projectionEffect) this.runProjectionEffect(projectionEffect);
        return record;
      }
      const state = this.state(input.sessionId)!;
      const unsigned = {
        schemaVersion: 1 as const,
        recordId: input.recordId,
        sequence: state.projected_sequence + 1,
        sessionId: input.sessionId,
        threadId: input.threadId,
        epoch: state.current_epoch,
        kind: input.kind,
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.message !== undefined ? { message: input.message } : {}),
        ...(input.rewind !== undefined ? { rewind: input.rewind } : {}),
        ...(input.payloadRef !== undefined ? { payloadRef: input.payloadRef } : {}),
        ...(input.projectionIntent !== undefined ? { projectionIntent: input.projectionIntent } : {}),
        createdAt: input.createdAt,
        previousHash: state.last_hash,
      };
      const record: HistoryRecord = { ...unsigned, recordHash: hashRecord(unsigned) };
      const { offset, length } = appendDurably(this.roomPath(input.sessionId), record);
      this.project(record, offset, length, projectionEffect);
      return record;
  }

  async rewind(
    sessionId: string,
    threadId: string,
    targetSequence: number,
    projectionEffect?: () => void,
    projectionIntent?: HistoryAppendInput["projectionIntent"],
  ): Promise<HistoryRecord> {
    return this.inSessionQueue(sessionId, async () => {
      this.ensureReady(sessionId);
      const state = this.state(sessionId)!;
      return this.appendUnlocked({
        recordId: `rewind:${crypto.randomUUID()}`, sessionId, threadId, kind: "rewind",
        rewind: { targetSequence, nextEpoch: state.current_epoch + 1 }, projectionIntent,
        createdAt: new Date().toISOString(),
      }, projectionEffect);
    });
  }

  async stageSessionDeletion(sessionId: string): Promise<{ commit(): void; rollback(): void }> {
    return this.inSessionQueue(sessionId, async () => {
      const source = join(this.historyDir, sessionId);
      if (!existsSync(source)) return { commit() {}, rollback() {} };
      const deletingRoot = join(this.historyDir, ".deleting");
      const staged = join(deletingRoot, crypto.randomUUID());
      const markerPath = join(source, ".deletion.json");
      mkdirSync(deletingRoot, { recursive: true });
      writeFileSync(markerPath, JSON.stringify({ sessionId }), { flag: "wx" });
      fsyncFile(markerPath);
      fsyncDirectory(source);
      try {
        renameSync(source, staged);
      } catch (error) {
        rmSync(markerPath, { force: true });
        fsyncDirectory(source);
        throw error;
      }
      fsyncDirectory(this.historyDir);
      fsyncDirectory(deletingRoot);
      return {
        commit: () => {
          rmSync(staged, { recursive: true, force: true });
          fsyncDirectory(deletingRoot);
        },
        rollback: () => {
          if (!existsSync(staged)) return;
          renameSync(staged, source);
          rmSync(join(source, ".deletion.json"), { force: true });
          fsyncDirectory(source);
          fsyncDirectory(this.historyDir);
          fsyncDirectory(deletingRoot);
        },
      };
    });
  }

  async appendMessage(
    input: AppendMessageInput & Pick<HistoryAppendInput, "projectionIntent">,
    projectionEffect?: () => void,
  ): Promise<HistoryRecord> {
    return this.append(this.messageInput(input), projectionEffect);
  }

  private messageInput(input: AppendMessageInput & Pick<HistoryAppendInput, "projectionIntent">): HistoryAppendInput {
    return {
      recordId: input.idempotencyKey,
      sessionId: input.roomId,
      threadId: input.threadId,
      kind: input.kind === "tool_call" ? "tool_call" : input.kind === "tool_result" ? "tool_result" : "message",
      role: input.role,
      agentId: input.agentId,
      content: input.content,
      message: {
        messageId: input.messageId ?? crypto.randomUUID(), runId: input.runId, turnId: input.turnId,
        kind: input.kind, parts: input.parts, status: input.status, idempotencyKey: input.idempotencyKey,
      },
      createdAt: input.createdAt ?? new Date().toISOString(),
      projectionIntent: input.projectionIntent,
    };
  }

  async reconcile(sessionId: string): Promise<void> {
    return this.inSessionQueue(sessionId, async () => this.reconcileUnlocked(sessionId));
  }

  status(sessionId: string): { status: string; error: string | null } | null {
    return this.db.query<{ status: string; error: string | null }, [string]>(
      "SELECT status, error FROM history_projection_state WHERE session_id = ?",
    ).get(sessionId);
  }

  roomPath(sessionId: string): string { return join(this.historyDir, sessionId, "room.jsonl"); }

  private ensureReady(sessionId: string): void {
    if (!this.state(sessionId)) this.bootstrapUnlocked(sessionId);
    let state = this.state(sessionId);
    if (!state || state.status !== "ready") throw new Error("history_read_only_recovery");
    const path = this.roomPath(sessionId);
    if ((!existsSync(path) && state.projected_offset > 0)
      || (existsSync(path) && statSync(path).size !== state.projected_offset)) {
      this.reconcileUnlocked(sessionId);
      state = this.state(sessionId);
      if (!state || state.status !== "ready") throw new Error("history_read_only_recovery");
    }
  }

  private bootstrapUnlocked(sessionId: string): void {
    const path = this.roomPath(sessionId);
    this.reconcileUnlocked(sessionId, false);
    this.exportProjection(sessionId);
    if (existsSync(path)) this.reconcileUnlocked(sessionId, true);
  }

  private exportProjection(sessionId: string): void {
    mkdirSync(dirname(this.roomPath(sessionId)), { recursive: true });
    const rows = this.db.query<any, [string]>(`
      SELECT * FROM session_messages WHERE session_id = ? ORDER BY COALESCE(sequence, rowid), rowid
    `).all(sessionId);
    this.ensureState(sessionId);
    for (const row of rows) {
      const recordId = row.idempotency_key ?? `legacy:${row.id}`;
      const exists = this.db.query<{ record_id: string }, [string, string]>(
        "SELECT record_id FROM history_projection_records WHERE session_id = ? AND record_id = ?",
      ).get(sessionId, recordId);
      if (exists) continue;
      const input: HistoryAppendInput = {
        recordId,
        sessionId,
        threadId: row.thread_id ?? `thread:${sessionId}`,
        kind: row.kind === "tool_call" ? "tool_call" : row.kind === "tool_result" ? "tool_result" : "message",
        role: row.role,
        agentId: row.agent_id ?? row.author_id,
        content: row.content,
        message: {
          messageId: row.id, runId: row.run_id, turnId: row.turn_id,
          kind: row.kind ?? (row.role === "tool" ? "tool_result" : "text"),
          parts: this.listParts(row.id), status: row.status, idempotencyKey: row.idempotency_key,
        },
        createdAt: row.created_at,
      };
      const state = this.state(sessionId)!;
      const unsigned = { schemaVersion: 1 as const, recordId: input.recordId, sequence: state.projected_sequence + 1,
        sessionId, threadId: input.threadId, epoch: state.current_epoch, kind: input.kind, role: input.role,
        agentId: input.agentId, content: input.content, message: input.message, createdAt: input.createdAt,
        previousHash: state.last_hash };
      const record: HistoryRecord = { ...unsigned, recordHash: hashRecord(unsigned) };
      const location = appendDurably(this.roomPath(sessionId), record);
      this.recordProjection(record, location.offset, location.length);
    }
  }

  private reconcileUnlocked(sessionId: string, verifyMessageProjection = true): void {
    this.ensureState(sessionId);
    const committed = this.state(sessionId)!;
    const path = this.roomPath(sessionId);
    if (!existsSync(path)) {
      if (committed.projected_offset > 0 || committed.projected_sequence > 0 || committed.last_hash !== null) {
        this.markRecovery(sessionId, "history_projection_checkpoint_missing");
        throw new Error("history_read_only_recovery");
      }
      return;
    }
    let bytes = readFileSync(path);
    const lastNewline = bytes.lastIndexOf(10);
    if (bytes.length && lastNewline !== bytes.length - 1) {
      truncateSync(path, Math.max(0, lastNewline + 1));
      bytes = bytes.subarray(0, Math.max(0, lastNewline + 1));
    }
    let offset = 0;
    let previousHash: string | null = null;
    let expectedSequence = 1;
    let expectedEpoch = 0;
    let checkpointMatched = committed.projected_offset === 0 && committed.projected_sequence === 0 && committed.last_hash === null;
    const records: Array<{ record: HistoryRecord; offset: number; length: number }> = [];
    for (const line of bytes.toString("utf8").split("\n")) {
      if (!line) continue;
      const length = Buffer.byteLength(`${line}\n`);
      try {
        const record = JSON.parse(line) as HistoryRecord;
        const { recordHash, ...unsigned } = record;
        if (record.previousHash !== previousHash || hashRecord(unsigned) !== recordHash) throw new Error("history_hash_mismatch");
        this.validateRecord(record, sessionId, expectedSequence, expectedEpoch);
        const endOffset = offset + length;
        if (endOffset === committed.projected_offset) {
          if (record.sequence !== committed.projected_sequence || recordHash !== committed.last_hash) {
            throw new Error("history_projection_checkpoint_mismatch");
          }
          checkpointMatched = true;
        } else if (endOffset > committed.projected_offset && !checkpointMatched) {
          throw new Error("history_projection_checkpoint_mismatch");
        }
        const projected = this.db.query<{ record_id: string }, [string, string]>(
          "SELECT record_id FROM history_projection_records WHERE session_id = ? AND record_id = ?",
        ).get(sessionId, record.recordId);
        if (!projected) this.project(record, offset, length);
        records.push({ record, offset, length });
        previousHash = recordHash;
        expectedSequence += 1;
        if (record.kind === "rewind") expectedEpoch = record.rewind!.nextEpoch;
      } catch (error) {
        this.markRecovery(sessionId, error instanceof Error ? error.message : String(error));
        throw new Error("history_read_only_recovery");
      }
      offset += length;
    }
    if (!checkpointMatched) {
      this.markRecovery(sessionId, "history_projection_checkpoint_missing");
      throw new Error("history_read_only_recovery");
    }
    if (!verifyMessageProjection) return;
    const expectedMessages = this.db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM history_projection_records
      WHERE session_id = ? AND active = 1 AND kind IN ('message', 'tool_call', 'tool_result')
    `).get(sessionId)?.count ?? 0;
    const projectedMessages = this.db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ?",
    ).get(sessionId)?.count ?? 0;
    if (expectedMessages !== projectedMessages) this.rebuildProjection(sessionId, records);
  }

  private project(record: HistoryRecord, offset: number, length: number, projectionEffect?: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const replayIntentBeforeProjection = !projectionEffect && record.kind === "rewind" && !!record.projectionIntent;
      if (replayIntentBeforeProjection) this.applyProjectionIntent(record);
      this.applyProjection(record, offset, length);
      if (projectionEffect) projectionEffect();
      else if (!replayIntentBeforeProjection) this.applyProjectionIntent(record);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private runProjectionEffect(effect: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      effect();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private applyProjection(record: HistoryRecord, offset: number, length: number): void {
    if (record.message) this.projectMessage(record);
    if (record.kind === "rewind" && record.rewind) this.projectRewind(record);
    this.recordProjection(record, offset, length);
  }

  private applyProjectionIntent(record: HistoryRecord): void {
    if (!record.projectionIntent) return;
    const handler = this.projectionHandlers.get(record.projectionIntent.type);
    if (!handler) throw new Error(`history_projection_handler_missing:${record.projectionIntent.type}`);
    handler(record);
  }

  private rebuildProjection(
    sessionId: string,
    records: Array<{ record: HistoryRecord; offset: number; length: number }>,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.query("DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM session_messages WHERE session_id = ?)").run(sessionId);
      this.db.query("DELETE FROM message_parts WHERE message_id IN (SELECT id FROM session_messages WHERE session_id = ?)").run(sessionId);
      this.db.query("DELETE FROM session_messages WHERE session_id = ?").run(sessionId);
      this.db.query("DELETE FROM history_projection_records WHERE session_id = ?").run(sessionId);
      this.db.query("DELETE FROM history_projection_state WHERE session_id = ?").run(sessionId);
      this.ensureState(sessionId);
      for (const item of records) this.applyProjection(item.record, item.offset, item.length);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private projectMessage(record: HistoryRecord): void {
    const message = record.message!;
    const existing = this.db.query<any, [string]>(
      "SELECT * FROM session_messages WHERE id = ?",
    ).get(message.messageId);
    if (existing) {
      const compatible = existing.session_id === record.sessionId
        && existing.thread_id === record.threadId
        && existing.run_id === message.runId
        && existing.turn_id === message.turnId
        && existing.agent_id === (record.agentId ?? null)
        && existing.role === (record.role ?? "assistant")
        && existing.kind === message.kind
        && existing.content === (record.content ?? "")
        && existing.status === message.status
        && existing.idempotency_key === message.idempotencyKey
        && canonicalJson(this.listParts(message.messageId)) === canonicalJson(message.parts);
      if (!compatible) throw new Error("history_message_projection_conflict");
    } else {
      this.db.query(`INSERT INTO session_messages
      (id, session_id, thread_id, run_id, turn_id, agent_id, role, author_id, kind, content, sequence, status, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(message.messageId, record.sessionId, record.threadId, message.runId, message.turnId,
          record.agentId ?? null, record.role ?? "assistant", record.agentId ?? null, message.kind,
          record.content ?? "", record.sequence, message.status, message.idempotencyKey, record.createdAt);
      this.insertParts(message.messageId, message.parts);
    }
    const insertAttachment = this.db.query(`INSERT OR IGNORE INTO message_attachments
      (message_id, attachment_id, ordinal) VALUES (?, ?, ?)`);
    message.parts.forEach((part, ordinal) => {
      if (part.type === "image" || part.type === "file") {
        insertAttachment.run(message.messageId, part.attachmentId, ordinal);
      } else if (part.type === "workspace_ref" && part.attachmentId) {
        insertAttachment.run(message.messageId, part.attachmentId, ordinal);
      }
    });
    this.db.query("UPDATE conversation_threads SET latest_sequence = MAX(latest_sequence, ?), updated_at = ? WHERE id = ?")
      .run(record.sequence, record.createdAt, record.threadId);
  }

  private projectRewind(record: HistoryRecord): void {
    const target = record.rewind!.targetSequence;
    const ids = this.db.query<{ record_id: string }, [string, string, number]>(
      "SELECT record_id FROM history_projection_records WHERE session_id = ? AND thread_id = ? AND sequence >= ? AND active = 1",
    ).all(record.sessionId, record.threadId, target).map((row) => row.record_id);
    const messageIds = ids.flatMap((recordId) => this.readRecord(record.sessionId, recordId).message?.messageId ?? []);
    if (messageIds.length) {
      const marks = messageIds.map(() => "?").join(",");
      this.db.query(`DELETE FROM message_attachments WHERE message_id IN (${marks})`).run(...messageIds);
      this.db.query(`DELETE FROM message_parts WHERE message_id IN (${marks})`).run(...messageIds);
      this.db.query(`DELETE FROM session_messages WHERE id IN (${marks})`).run(...messageIds);
    }
    this.db.query("UPDATE history_projection_records SET active = 0 WHERE session_id = ? AND thread_id = ? AND sequence >= ?")
      .run(record.sessionId, record.threadId, target);
    this.db.query("UPDATE conversation_threads SET latest_sequence = MAX(0, ? - 1), updated_at = ? WHERE id = ?")
      .run(target, record.createdAt, record.threadId);
  }

  private recordProjection(record: HistoryRecord, offset: number, length: number): void {
    this.db.query(`INSERT INTO history_projection_records
      (record_id, session_id, thread_id, kind, sequence, epoch, byte_offset, byte_length, record_hash, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
      .run(record.recordId, record.sessionId, record.threadId, record.kind, record.sequence, record.epoch, offset, length, record.recordHash, record.createdAt);
    const epoch = record.kind === "rewind" && record.rewind ? record.rewind.nextEpoch : record.epoch;
    this.db.query(`UPDATE history_projection_state SET projected_offset = ?, projected_sequence = ?, current_epoch = ?,
      last_hash = ?, status = 'ready', error = NULL, updated_at = ? WHERE session_id = ?`)
      .run(offset + length, record.sequence, epoch, record.recordHash, new Date().toISOString(), record.sessionId);
  }

  private validateRecord(record: HistoryRecord, sessionId: string, expectedSequence: number, expectedEpoch: number): void {
    if (record.schemaVersion !== 1) throw new Error("history_schema_version_unsupported");
    if (record.sessionId !== sessionId) throw new Error("history_session_mismatch");
    if (record.sequence !== expectedSequence) throw new Error("history_sequence_gap");
    if (record.epoch !== expectedEpoch) throw new Error("history_epoch_mismatch");
    if (!record.recordId || !record.threadId || !record.recordHash) throw new Error("history_record_invalid");
    const kinds = new Set(["message", "tool_call", "tool_result", "memory_mutation", "compaction", "rewind"]);
    if (!kinds.has(record.kind)) throw new Error("history_record_kind_invalid");
    if (["message", "tool_call", "tool_result"].includes(record.kind) && !record.message) {
      throw new Error("history_message_payload_missing");
    }
    if (record.kind === "rewind") {
      if (!record.rewind) throw new Error("history_rewind_payload_missing");
      if (!Number.isInteger(record.rewind.targetSequence) || record.rewind.targetSequence < 1
        || record.rewind.targetSequence >= record.sequence
        || record.rewind.nextEpoch !== expectedEpoch + 1) throw new Error("history_rewind_payload_invalid");
    }
    const thread = this.db.query<{ room_id: string }, [string]>(
      "SELECT room_id FROM conversation_threads WHERE id = ?",
    ).get(record.threadId);
    if (!thread || thread.room_id !== sessionId) throw new Error("history_thread_ownership_mismatch");
    this.validateProjectionIntent(record);
  }

  private validateProjectionIntent(record: HistoryRecord): void {
    const intent = record.projectionIntent;
    if (!intent) return;
    if (!intent.type || !intent.payload || typeof intent.payload !== "object") {
      throw new Error("history_projection_intent_invalid");
    }
    const payload = intent.payload;
    const requireString = (key: string): string => {
      const value = payload[key];
      if (typeof value !== "string" || !value) throw new Error("history_projection_intent_invalid");
      return value;
    };
    const requireStrings = (key: string): string[] => {
      const value = payload[key];
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new Error("history_projection_intent_invalid");
      }
      return value;
    };
    if ("roomId" in payload && requireString("roomId") !== record.sessionId) {
      throw new Error("history_projection_intent_session_mismatch");
    }
    if ("sessionId" in payload && requireString("sessionId") !== record.sessionId) {
      throw new Error("history_projection_intent_session_mismatch");
    }
    if ("threadId" in payload && requireString("threadId") !== record.threadId) {
      throw new Error("history_projection_intent_thread_mismatch");
    }
    switch (intent.type) {
      case "conversation.begin_turn":
        if (requireString("roomId") !== record.sessionId || requireString("threadId") !== record.threadId
          || requireString("turnId") !== record.message?.turnId || requireString("prompt") !== record.content) {
          throw new Error("history_projection_intent_invalid");
        }
        requireString("runId"); requireString("agentId"); requireString("clientTurnKey"); requireString("inputHash");
        requireString("createdAt");
        break;
      case "conversation.complete_turn":
      case "conversation.terminate_turn":
        if (requireString("roomId") !== record.sessionId || requireString("runId") !== record.message?.runId
          || requireString("turnId") !== record.message?.turnId) throw new Error("history_projection_intent_invalid");
        requireString("completedAt");
        if (intent.type === "conversation.terminate_turn") {
          if (!["failed", "cancelled"].includes(requireString("status"))) throw new Error("history_projection_intent_invalid");
          requireString("error");
        }
        break;
      case "multi_task.create":
        if (requireString("sessionId") !== record.sessionId || requireString("id") !== record.message?.runId) {
          throw new Error("history_projection_intent_invalid");
        }
        requireString("attemptId");
        if (requireString("prompt") !== record.content) throw new Error("history_projection_intent_invalid");
        requireString("createdAt");
        break;
      case "session.rewind":
        if (record.kind !== "rewind" || requireString("sessionId") !== record.sessionId
          || requireString("threadId") !== record.threadId
          || payload.targetSequence !== record.rewind?.targetSequence) {
          throw new Error("history_projection_intent_invalid");
        }
        requireStrings("messageIds"); requireStrings("runIds"); requireStrings("turnIds");
        break;
      default:
        throw new Error("history_projection_intent_unknown");
    }
  }

  private ensureState(sessionId: string): void {
    this.db.query(`INSERT OR IGNORE INTO history_projection_state
      (session_id, projected_offset, projected_sequence, current_epoch, last_hash, status, updated_at)
      VALUES (?, 0, 0, 0, NULL, 'ready', ?)`)
      .run(sessionId, new Date().toISOString());
  }

  private state(sessionId: string): ProjectionState | null {
    return this.db.query<ProjectionState, [string]>("SELECT * FROM history_projection_state WHERE session_id = ?").get(sessionId);
  }

  private markRecovery(sessionId: string, error: string): void {
    this.db.query("UPDATE history_projection_state SET status = 'recovery', error = ?, updated_at = ? WHERE session_id = ?")
      .run(error, new Date().toISOString(), sessionId);
  }

  private recoverStagedDeletions(): void {
    if (existsSync(this.historyDir)) {
      for (const entry of readdirSync(this.historyDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === ".deleting") continue;
        const live = join(this.historyDir, entry.name);
        const markerPath = join(live, ".deletion.json");
        if (!existsSync(markerPath)) continue;
        try {
          const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { sessionId?: string };
          const sessionExists = marker.sessionId
            ? this.db.query<{ id: string }, [string]>("SELECT id FROM sessions WHERE id = ?").get(marker.sessionId)
            : null;
          if (sessionExists && marker.sessionId === entry.name) {
            rmSync(markerPath, { force: true });
            fsyncDirectory(live);
            fsyncDirectory(this.historyDir);
          } else if (marker.sessionId === entry.name) {
            rmSync(live, { recursive: true, force: true });
            fsyncDirectory(this.historyDir);
          }
        } catch {
          // Keep malformed markers intact for manual recovery.
        }
      }
    }
    const deletingRoot = join(this.historyDir, ".deleting");
    if (!existsSync(deletingRoot)) return;
    for (const entry of readdirSync(deletingRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const staged = join(deletingRoot, entry.name);
      try {
        const marker = JSON.parse(readFileSync(join(staged, ".deletion.json"), "utf8")) as { sessionId?: string };
        if (!marker.sessionId) throw new Error("history_deletion_marker_invalid");
        const sessionExists = this.db.query<{ id: string }, [string]>("SELECT id FROM sessions WHERE id = ?").get(marker.sessionId);
        if (sessionExists) {
          const destination = join(this.historyDir, marker.sessionId);
          if (existsSync(destination)) throw new Error("history_deletion_restore_conflict");
          renameSync(staged, destination);
          rmSync(join(destination, ".deletion.json"), { force: true });
          fsyncDirectory(destination);
          fsyncDirectory(this.historyDir);
          fsyncDirectory(deletingRoot);
        } else {
          rmSync(staged, { recursive: true, force: true });
          fsyncDirectory(deletingRoot);
        }
      } catch {
        // Keep malformed or conflicting staged data intact for manual recovery.
      }
    }
    fsyncDirectory(this.historyDir);
  }

  private readRecord(sessionId: string, recordId: string): HistoryRecord {
    const row = this.db.query<{ byte_offset: number; byte_length: number }, [string, string]>(
      "SELECT byte_offset, byte_length FROM history_projection_records WHERE session_id = ? AND record_id = ?",
    ).get(sessionId, recordId);
    if (!row) throw new Error("history_record_not_found");
    const bytes = readFileSync(this.roomPath(sessionId)).subarray(row.byte_offset, row.byte_offset + row.byte_length);
    return JSON.parse(bytes.toString("utf8")) as HistoryRecord;
  }

  private insertParts(messageId: string, parts: MessagePart[]): void {
    const exists = this.db.query<{ id: string }, [string]>("SELECT id FROM message_parts WHERE message_id = ? LIMIT 1").get(messageId);
    if (exists) return;
    const insert = this.db.query(`INSERT INTO message_parts
      (id, message_id, ordinal, type, text, attachment_id, tool_call_id, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    parts.forEach((part, ordinal) => {
      if (part.type === "text" || part.type === "reasoning_summary") insert.run(crypto.randomUUID(), messageId, ordinal, part.type, part.text, null, null, null);
      else if (part.type === "tool_call") insert.run(crypto.randomUUID(), messageId, ordinal, part.type, null, null, part.callId, JSON.stringify({ name: part.name, input: part.input }));
      else if (part.type === "tool_result") insert.run(crypto.randomUUID(), messageId, ordinal, part.type, null, null, part.callId, JSON.stringify({ output: part.output, isError: part.isError }));
      else if (part.type === "image" || part.type === "file") insert.run(crypto.randomUUID(), messageId, ordinal, part.type, null, part.attachmentId, null, JSON.stringify(part));
      else insert.run(crypto.randomUUID(), messageId, ordinal, part.type, null, null, null, JSON.stringify(part));
    });
  }

  private listParts(messageId: string): MessagePart[] {
    const rows = this.db.query<any, [string]>("SELECT type, text, attachment_id, tool_call_id, metadata_json FROM message_parts WHERE message_id = ? ORDER BY ordinal").all(messageId);
    return rows.flatMap((row): MessagePart[] => {
      const data = row.metadata_json ? JSON.parse(row.metadata_json) : {};
      if (row.type === "text" || row.type === "reasoning_summary") return [{ type: row.type, text: row.text ?? "" }];
      if (row.type === "tool_call") return [{ type: "tool_call", callId: row.tool_call_id, name: data.name, input: data.input }];
      if (row.type === "tool_result") return [{ type: "tool_result", callId: row.tool_call_id, output: data.output, isError: data.isError === true }];
      if (row.type === "image") return [{ type: "image", attachmentId: row.attachment_id, mediaType: data.mediaType ?? "application/octet-stream", alt: data.alt }];
      if (row.type === "file") return [{ type: "file", attachmentId: row.attachment_id, mediaType: data.mediaType ?? "application/octet-stream", filename: data.filename ?? "file" }];
      if (row.type === "workspace_ref") return [{ type: "workspace_ref", refId: data.refId ?? "", relativePath: data.relativePath ?? "", snapshotHash: data.snapshotHash, attachmentId: data.attachmentId }];
      return [];
    });
  }

  private inSessionQueue<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.queues.set(sessionId, queued);
    return previous.catch(() => undefined).then(work).finally(() => {
      release();
      if (this.queues.get(sessionId) === queued) this.queues.delete(sessionId);
    });
  }
}

function hashRecord(record: Omit<HistoryRecord, "recordHash">): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function assertCompatibleRecord(record: HistoryRecord, input: HistoryAppendInput): void {
  const existingIdentity = canonicalJson({
    sessionId: record.sessionId,
    threadId: record.threadId,
    kind: record.kind,
    role: record.role,
    agentId: record.agentId,
    content: record.content,
    message: record.message ? {
      runId: record.message.runId,
      turnId: record.message.turnId,
      kind: record.message.kind,
      parts: record.message.parts,
      status: record.message.status,
      idempotencyKey: record.message.idempotencyKey,
    } : undefined,
    rewind: record.rewind,
    payloadRef: record.payloadRef,
    projectionIntent: comparableProjectionIntent(record.projectionIntent),
  });
  const inputIdentity = canonicalJson({
    sessionId: input.sessionId,
    threadId: input.threadId,
    kind: input.kind,
    role: input.role,
    agentId: input.agentId,
    content: input.content,
    message: input.message ? {
      runId: input.message.runId,
      turnId: input.message.turnId,
      kind: input.message.kind,
      parts: input.message.parts,
      status: input.message.status,
      idempotencyKey: input.message.idempotencyKey,
    } : undefined,
    rewind: input.rewind,
    payloadRef: input.payloadRef,
    projectionIntent: comparableProjectionIntent(input.projectionIntent),
  });
  if (existingIdentity !== inputIdentity) throw new Error("history_idempotency_conflict");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function comparableProjectionIntent(intent: HistoryRecord["projectionIntent"]): unknown {
  if (!intent) return undefined;
  const payload = Object.fromEntries(Object.entries(intent.payload)
    .filter(([key]) => !["createdAt", "updatedAt", "completedAt"].includes(key)));
  return { type: intent.type, payload };
}

function appendDurably(path: string, record: HistoryRecord): { offset: number; length: number } {
  const parentPath = dirname(path);
  const parentExisted = existsSync(parentPath);
  mkdirSync(parentPath, { recursive: true });
  const existed = existsSync(path);
  const offset = existed ? statSync(path).size : 0;
  const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  const fd = openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY, 0o600);
  try {
    let written = 0;
    while (written < line.byteLength) written += writeSync(fd, line, written);
    fdatasyncSync(fd);
  } finally { closeSync(fd); }
  if (!existed) {
    fsyncDirectory(parentPath);
    if (!parentExisted) fsyncDirectory(dirname(parentPath));
  }
  return { offset, length: line.byteLength };
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function fsyncFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
