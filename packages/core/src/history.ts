import type { MessagePart } from "./message-parts";
import type { StoredMessageKind, StoredMessageRole } from "./conversation-memory";

export type HistoryRecordKind = "message" | "tool_call" | "tool_result" | "memory_mutation" | "compaction" | "rewind";

export interface HistoryProjectionIntent {
  type: string;
  payload: Record<string, unknown>;
}

export interface HistoryPointer {
  sessionId: string;
  threadId: string;
  sequence: number;
  recordId: string;
  uri: string;
}

export interface HistoryRecord {
  schemaVersion: 1;
  recordId: string;
  sequence: number;
  sessionId: string;
  threadId: string;
  epoch: number;
  kind: HistoryRecordKind;
  role?: StoredMessageRole;
  agentId?: string | null;
  content?: string;
  message?: {
    messageId: string;
    runId: string | null;
    turnId: string | null;
    kind: StoredMessageKind;
    parts: MessagePart[];
    status: string;
    idempotencyKey: string | null;
  };
  rewind?: { targetSequence: number; nextEpoch: number };
  payloadRef?: { storageKey: string; sha256: string; byteSize: number };
  projectionIntent?: HistoryProjectionIntent;
  createdAt: string;
  previousHash: string | null;
  recordHash: string;
}

export function historyPointer(record: HistoryRecord): HistoryPointer {
  return {
    sessionId: record.sessionId,
    threadId: record.threadId,
    sequence: record.sequence,
    recordId: record.recordId,
    uri: `history://session/${encodeURIComponent(record.sessionId)}/thread/${encodeURIComponent(record.threadId)}#seq=${record.sequence}`,
  };
}
