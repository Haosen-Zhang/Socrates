import type { Database } from "bun:sqlite";
import { isActiveConversationTurnStatus } from "@socrates/core";
import type {
  AppendMessageInput,
  ConversationTurnStatus,
  ConversationMemoryStore as ConversationMemoryStoreContract,
  ConversationStoredMessage,
  ConversationThread,
  MessagePart,
  StoredMessageKind,
  StoredMessageRole,
  ToolOutputRef,
} from "@socrates/core";

type ThreadRow = {
  id: string;
  room_id: string;
  is_default: number;
  latest_sequence: number;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  session_id: string;
  thread_id: string;
  run_id: string | null;
  turn_id: string | null;
  agent_id: string | null;
  role: StoredMessageRole;
  kind: StoredMessageKind;
  content: string;
  sequence: number;
  created_at: string;
  status: ConversationTurnStatus;
  idempotency_key: string | null;
};

type PartRow = {
  type: MessagePart["type"];
  text: string | null;
  attachment_id: string | null;
  tool_call_id: string | null;
  metadata_json: string | null;
};

type TurnRow = {
  id: string;
  room_id: string;
  thread_id: string;
  client_turn_key: string;
  input_hash: string;
  run_id: string | null;
  agent_id: string;
  status: ConversationTurnStatus;
  attempt_no: number;
  context_truncated: number;
  context_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export interface PreparedConversationTurn {
  turnId: string;
  threadId: string;
  runId: string;
  agentId: string;
  attemptNo: number;
  status: string;
  replayed: boolean;
  userMessage: ConversationStoredMessage;
}

export interface BeginConversationTurnInput {
  roomId: string;
  threadId: string;
  clientTurnKey: string;
  inputHash: string;
  runId: string;
  agentId: string;
  prompt: string;
  parts: MessagePart[];
  createdAt?: string;
}

export interface CompleteConversationTurnInput {
  roomId: string;
  runId: string;
  turnId: string;
  completedAt: string;
  assistantMessage?: AppendMessageInput;
}

export interface TerminateConversationTurnInput {
  roomId: string;
  runId: string;
  turnId: string;
  status: "failed" | "cancelled";
  error: string;
  completedAt: string;
  assistantMessage?: AppendMessageInput;
}

const toThread = (row: ThreadRow): ConversationThread => ({
  id: row.id,
  roomId: row.room_id,
  isDefault: row.is_default === 1,
  latestSequence: row.latest_sequence,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export class ConversationMemoryStore implements ConversationMemoryStoreContract {
  constructor(private readonly db: Database) {}

  createThread(roomId: string, options: { id?: string; isDefault?: boolean } = {}): ConversationThread {
    if (!this.db.query("SELECT id FROM sessions WHERE id = ?").get(roomId)) throw new Error("room_not_found");
    const id = options.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.query(`
      INSERT INTO conversation_threads
        (id, room_id, is_default, latest_sequence, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?)
    `).run(id, roomId, options.isDefault ? 1 : 0, now, now);
    return this.getThread(id)!;
  }

  ensureDefaultThread(roomId: string): ConversationThread {
    const existing = this.db.query<ThreadRow, [string]>(
      "SELECT * FROM conversation_threads WHERE room_id = ? AND is_default = 1",
    ).get(roomId);
    if (existing) return toThread(existing);
    return this.createThread(roomId, { id: `thread:${roomId}`, isDefault: true });
  }

  getThread(threadId: string): ConversationThread | null {
    const row = this.db.query<ThreadRow, [string]>("SELECT * FROM conversation_threads WHERE id = ?").get(threadId);
    return row ? toThread(row) : null;
  }

  async appendMessage(input: AppendMessageInput): Promise<ConversationStoredMessage> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const message = this.appendMessageInTransaction(input);
      this.db.exec("COMMIT");
      return message;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Atomically creates a durable Turn, its Agent run attempt, and the user
   * message. Reusing a completed client key replays the terminal Turn; reusing a
   * failed/interrupted key creates a new attempt without duplicating the user
   * message.
   */
  beginTurn(input: BeginConversationTurnInput): PreparedConversationTurn {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = input.createdAt ?? new Date().toISOString();
      const existing = this.db.query<TurnRow, [string, string]>(`
        SELECT * FROM conversation_turns
        WHERE thread_id = ? AND client_turn_key = ?
      `).get(input.threadId, input.clientTurnKey);
      if (existing) {
        if (existing.room_id !== input.roomId || existing.agent_id !== input.agentId || existing.input_hash !== input.inputHash) {
          throw new Error("client_turn_key_conflict");
        }
        const userMessage = this.findByIdempotencyKey(input.threadId, `turn-user:${existing.id}`);
        if (!userMessage) throw new Error("turn_user_message_missing");
        if (existing.status === "completed") {
          if (!existing.run_id) throw new Error("completed_turn_missing_run");
          this.db.exec("COMMIT");
          return {
            turnId: existing.id,
            threadId: existing.thread_id,
            runId: existing.run_id,
            agentId: existing.agent_id,
            attemptNo: existing.attempt_no,
            status: existing.status,
            replayed: true,
            userMessage,
          };
        }
        if (isActiveConversationTurnStatus(existing.status)) {
          throw new Error("turn_already_running");
        }
        const attemptNo = existing.attempt_no + 1;
        this.db.query(`
          UPDATE conversation_turns
          SET run_id = ?, status = 'preparing', attempt_no = ?, updated_at = ?, completed_at = NULL
          WHERE id = ?
        `).run(input.runId, attemptNo, now, existing.id);
        this.insertAgentRun(input.runId, input.roomId, input.prompt, input.threadId, existing.id, attemptNo, now);
        this.db.query("UPDATE sessions SET status = 'preparing', updated_at = ? WHERE id = ?").run(now, input.roomId);
        this.db.exec("COMMIT");
        return {
          turnId: existing.id,
          threadId: existing.thread_id,
          runId: input.runId,
          agentId: existing.agent_id,
          attemptNo,
          status: "preparing",
          replayed: false,
          userMessage,
        };
      }

      const thread = this.db.query<ThreadRow, [string]>("SELECT * FROM conversation_threads WHERE id = ?").get(input.threadId);
      if (!thread || thread.room_id !== input.roomId) throw new Error("conversation_thread_not_found");
      const turnId = `turn:${crypto.randomUUID()}`;
      this.db.query(`
        INSERT INTO conversation_turns
          (id, room_id, thread_id, client_turn_key, input_hash, run_id, agent_id,
           status, attempt_no, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'preparing', 1, ?, ?)
      `).run(
        turnId,
        input.roomId,
        input.threadId,
        input.clientTurnKey,
        input.inputHash,
        input.runId,
        input.agentId,
        now,
        now,
      );
      const userMessage = this.appendMessageInTransaction({
        roomId: input.roomId,
        threadId: input.threadId,
        runId: input.runId,
        turnId,
        agentId: null,
        role: "user",
        kind: "text",
        content: input.prompt,
        parts: [{ type: "text", text: input.prompt }, ...input.parts],
        status: "completed",
        idempotencyKey: `turn-user:${turnId}`,
        createdAt: now,
      });
      this.insertAgentRun(input.runId, input.roomId, input.prompt, input.threadId, turnId, 1, now);
      this.db.query("UPDATE sessions SET status = 'preparing', updated_at = ? WHERE id = ?").run(now, input.roomId);
      this.db.exec("COMMIT");
      return {
        turnId,
        threadId: input.threadId,
        runId: input.runId,
        agentId: input.agentId,
        attemptNo: 1,
        status: "preparing",
        replayed: false,
        userMessage,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateTurnStatus(
    turnId: string,
    status: ConversationTurnStatus,
    options: { completedAt?: string | null; context?: Record<string, unknown>; contextTruncated?: boolean } = {},
  ): void {
    const now = new Date().toISOString();
    const result = this.db.query(`
      UPDATE conversation_turns
      SET status = ?, context_truncated = COALESCE(?, context_truncated),
          context_json = COALESCE(?, context_json), updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(
      status,
      options.contextTruncated === undefined ? null : options.contextTruncated ? 1 : 0,
      options.context === undefined ? null : JSON.stringify(options.context),
      now,
      options.completedAt === undefined ? null : options.completedAt,
      turnId,
    );
    if (result.changes !== 1) throw new Error("conversation_turn_not_found");
  }

  /**
   * Commits the final public assistant message and every terminal projection in
   * one SQLite transaction. A process crash can expose either all of the final
   * Turn or none of it, never a final answer attached to a retryable Turn.
   */
  completeTurn(input: CompleteConversationTurnInput): ConversationStoredMessage | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const message = input.assistantMessage
        ? this.appendMessageInTransaction(input.assistantMessage)
        : null;
      const run = this.db.query(`
        UPDATE agent_runs
        SET status = 'completed', error = NULL, completed_at = ?
        WHERE id = ? AND session_id = ? AND turn_id = ?
      `).run(input.completedAt, input.runId, input.roomId, input.turnId);
      if (run.changes !== 1) throw new Error("agent_run_completion_conflict");
      const session = this.db.query(`
        UPDATE sessions SET status = 'completed', updated_at = ? WHERE id = ?
      `).run(input.completedAt, input.roomId);
      if (session.changes !== 1) throw new Error("session_completion_conflict");
      const turn = this.db.query(`
        UPDATE conversation_turns
        SET status = 'completed', updated_at = ?, completed_at = ?
        WHERE id = ? AND room_id = ? AND run_id = ?
      `).run(
        input.completedAt,
        input.completedAt,
        input.turnId,
        input.roomId,
        input.runId,
      );
      if (turn.changes !== 1) throw new Error("conversation_turn_completion_conflict");
      this.db.exec("COMMIT");
      return message;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Atomically keeps any public partial response and records a terminal error. */
  terminateTurn(input: TerminateConversationTurnInput): ConversationStoredMessage | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const message = input.assistantMessage
        ? this.appendMessageInTransaction(input.assistantMessage)
        : null;
      const run = this.db.query(`
        UPDATE agent_runs
        SET status = ?, error = ?, completed_at = ?
        WHERE id = ? AND session_id = ? AND turn_id = ?
      `).run(
        input.status,
        input.error,
        input.completedAt,
        input.runId,
        input.roomId,
        input.turnId,
      );
      if (run.changes !== 1) throw new Error("agent_run_termination_conflict");
      const session = this.db.query(`
        UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?
      `).run(input.status, input.completedAt, input.roomId);
      if (session.changes !== 1) throw new Error("session_termination_conflict");
      const turn = this.db.query(`
        UPDATE conversation_turns
        SET status = ?, updated_at = ?, completed_at = ?
        WHERE id = ? AND room_id = ? AND run_id = ?
      `).run(
        input.status,
        input.completedAt,
        input.completedAt,
        input.turnId,
        input.roomId,
        input.runId,
      );
      if (turn.changes !== 1) throw new Error("conversation_turn_termination_conflict");
      this.db.exec("COMMIT");
      return message;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getTurn(turnId: string): TurnRow | null {
    return this.db.query<TurnRow, [string]>("SELECT * FROM conversation_turns WHERE id = ?").get(turnId) ?? null;
  }

  async listThreadMessages(
    threadId: string,
    options: { afterSequence?: number; limit?: number } = {},
  ): Promise<ConversationStoredMessage[]> {
    const after = Math.max(0, options.afterSequence ?? 0);
    const limit = Math.max(1, Math.min(options.limit ?? 10_000, 10_000));
    const rows = options.afterSequence !== undefined
      ? this.db.query<MessageRow, [string, number, number]>(`
          SELECT id, session_id, thread_id, run_id, turn_id, agent_id, role, kind,
                 content, sequence, created_at, status, idempotency_key
          FROM session_messages
          WHERE thread_id = ? AND sequence > ?
          ORDER BY sequence
          LIMIT ?
        `).all(threadId, after, limit)
      : this.db.query<MessageRow, [string, number]>(`
          SELECT * FROM (
            SELECT id, session_id, thread_id, run_id, turn_id, agent_id, role, kind,
                   content, sequence, created_at, status, idempotency_key
            FROM session_messages
            WHERE thread_id = ?
            ORDER BY sequence DESC
            LIMIT ?
          )
          ORDER BY sequence
        `).all(threadId, limit);
    return rows.map((row) => this.toMessage(row));
  }

  async getLatestSequence(threadId: string): Promise<number> {
    const row = this.db.query<{ latest_sequence: number }, [string]>(
      "SELECT latest_sequence FROM conversation_threads WHERE id = ?",
    ).get(threadId);
    if (!row) throw new Error("conversation_thread_not_found");
    return row.latest_sequence;
  }

  getMessage(messageId: string): ConversationStoredMessage | null {
    const row = this.db.query<MessageRow, [string]>(`
      SELECT id, session_id, thread_id, run_id, turn_id, agent_id, role, kind,
             content, sequence, created_at, status, idempotency_key
      FROM session_messages WHERE id = ?
    `).get(messageId);
    return row ? this.toMessage(row) : null;
  }

  private appendMessageInTransaction(input: AppendMessageInput): ConversationStoredMessage {
    const existing = this.findByIdempotencyKey(input.threadId, input.idempotencyKey);
    if (existing) {
      const existingIdentity = canonicalJson({
        roomId: existing.roomId,
        threadId: existing.threadId,
        turnId: existing.turnId,
        agentId: existing.agentId,
        role: existing.role,
        kind: existing.kind,
        content: existing.content,
        parts: existing.parts,
      });
      const inputIdentity = canonicalJson({
        roomId: input.roomId,
        threadId: input.threadId,
        turnId: input.turnId,
        agentId: input.agentId,
        role: input.role,
        kind: input.kind,
        content: input.content,
        parts: input.parts,
      });
      if (existingIdentity !== inputIdentity) throw new Error("message_idempotency_conflict");
      return existing;
    }
    const thread = this.db.query<ThreadRow, [string]>("SELECT * FROM conversation_threads WHERE id = ?").get(input.threadId);
    if (!thread || thread.room_id !== input.roomId) throw new Error("conversation_thread_not_found");
    const now = input.createdAt ?? new Date().toISOString();
    const sequence = thread.latest_sequence + 1;
    const messageId = input.messageId ?? crypto.randomUUID();
    this.db.query(`
      INSERT INTO session_messages
        (id, session_id, thread_id, run_id, turn_id, agent_id, role, author_id,
         kind, content, sequence, status, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      messageId,
      input.roomId,
      input.threadId,
      input.runId,
      input.turnId,
      input.agentId,
      input.role,
      input.agentId,
      input.kind,
      input.content,
      sequence,
      input.status,
      input.idempotencyKey,
      now,
    );
    this.insertParts(messageId, input.parts);
    const insertAttachment = this.db.query(`
      INSERT OR IGNORE INTO message_attachments (message_id, attachment_id, ordinal)
      VALUES (?, ?, ?)
    `);
    input.parts.forEach((part, ordinal) => {
      if (part.type === "image" || part.type === "file") insertAttachment.run(messageId, part.attachmentId, ordinal);
      else if (part.type === "workspace_ref" && part.attachmentId) {
        insertAttachment.run(messageId, part.attachmentId, ordinal);
      }
    });
    this.db.query("UPDATE conversation_threads SET latest_sequence = ?, updated_at = ? WHERE id = ?")
      .run(sequence, now, input.threadId);
    return this.getMessage(messageId)!;
  }

  private insertAgentRun(
    runId: string,
    roomId: string,
    prompt: string,
    threadId: string,
    turnId: string,
    attemptNo: number,
    createdAt: string,
  ): void {
    this.db.query(`
      INSERT INTO agent_runs
        (id, session_id, prompt, status, thread_id, turn_id, attempt_no, created_at)
      VALUES (?, ?, ?, 'preparing', ?, ?, ?, ?)
    `).run(runId, roomId, prompt, threadId, turnId, attemptNo, createdAt);
  }

  private findByIdempotencyKey(threadId: string, key: string): ConversationStoredMessage | null {
    const row = this.db.query<MessageRow, [string, string]>(`
      SELECT id, session_id, thread_id, run_id, turn_id, agent_id, role, kind,
             content, sequence, created_at, status, idempotency_key
      FROM session_messages WHERE thread_id = ? AND idempotency_key = ?
    `).get(threadId, key);
    return row ? this.toMessage(row) : null;
  }

  private toMessage(row: MessageRow): ConversationStoredMessage {
    return {
      messageId: row.id,
      roomId: row.session_id,
      threadId: row.thread_id,
      runId: row.run_id,
      turnId: row.turn_id,
      agentId: row.agent_id,
      role: row.role,
      kind: row.kind,
      content: row.content,
      parts: this.listParts(row.id),
      sequence: row.sequence,
      createdAt: row.created_at,
      status: row.status,
      idempotencyKey: row.idempotency_key,
    };
  }

  private insertParts(messageId: string, parts: MessagePart[]): void {
    const insert = this.db.query(`
      INSERT INTO message_parts
        (id, message_id, ordinal, type, text, attachment_id, tool_call_id, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    parts.forEach((part, ordinal) => {
      if (part.type === "text" || part.type === "reasoning_summary") {
        insert.run(crypto.randomUUID(), messageId, ordinal, part.type, part.text, null, null, null);
      } else if (part.type === "image" || part.type === "file") {
        insert.run(
          crypto.randomUUID(), messageId, ordinal, part.type, null, part.attachmentId, null,
          JSON.stringify(part.type === "image"
            ? { mediaType: part.mediaType, alt: part.alt }
            : { mediaType: part.mediaType, filename: part.filename }),
        );
      } else if (part.type === "workspace_ref") {
        insert.run(
          crypto.randomUUID(), messageId, ordinal, part.type, null, null, null,
          JSON.stringify({
            refId: part.refId,
            relativePath: part.relativePath,
            snapshotHash: part.snapshotHash,
            attachmentId: part.attachmentId,
          }),
        );
      } else if (part.type === "tool_call") {
        insert.run(
          crypto.randomUUID(), messageId, ordinal, part.type, null, null, part.callId,
          JSON.stringify({ name: part.name, input: part.input }),
        );
      } else {
        insert.run(
          crypto.randomUUID(), messageId, ordinal, part.type, null, null, part.callId,
          JSON.stringify({ output: part.output, isError: part.isError }),
        );
      }
    });
  }

  private listParts(messageId: string): MessagePart[] {
    return this.db.query<PartRow, [string]>(`
      SELECT type, text, attachment_id, tool_call_id, metadata_json
      FROM message_parts WHERE message_id = ? ORDER BY ordinal
    `).all(messageId).flatMap((part): MessagePart[] => {
      const metadata = part.metadata_json ? JSON.parse(part.metadata_json) as Record<string, any> : {};
      if (part.type === "text") return [{ type: "text", text: part.text ?? "" }];
      if (part.type === "reasoning_summary") return [{ type: "reasoning_summary", text: part.text ?? "" }];
      if (part.type === "image" && part.attachment_id) return [{
        type: "image", attachmentId: part.attachment_id, mediaType: String(metadata.mediaType ?? "application/octet-stream"),
        ...(typeof metadata.alt === "string" ? { alt: metadata.alt } : {}),
      }];
      if (part.type === "file" && part.attachment_id) return [{
        type: "file", attachmentId: part.attachment_id, mediaType: String(metadata.mediaType ?? "application/octet-stream"),
        filename: String(metadata.filename ?? "file"),
      }];
      if (part.type === "workspace_ref") return [{
        type: "workspace_ref", refId: String(metadata.refId ?? ""), relativePath: String(metadata.relativePath ?? ""),
        ...(typeof metadata.snapshotHash === "string" ? { snapshotHash: metadata.snapshotHash } : {}),
        ...(typeof metadata.attachmentId === "string" ? { attachmentId: metadata.attachmentId } : {}),
      }];
      if (part.type === "tool_call" && part.tool_call_id) return [{
        type: "tool_call", callId: part.tool_call_id, name: String(metadata.name ?? ""), input: metadata.input,
      }];
      if (part.type === "tool_result" && part.tool_call_id) return [{
        type: "tool_result", callId: part.tool_call_id,
        output: metadata.output as ToolOutputRef,
        isError: metadata.isError === true,
      }];
      return [];
    });
  }
}
