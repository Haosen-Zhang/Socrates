import type { MessagePart } from "./message-parts";

export type StoredMessageRole = "system" | "user" | "assistant" | "tool";
export type StoredMessageKind = "text" | "tool_call" | "tool_result" | "summary" | "error";

export interface ConversationStoredMessage {
  messageId: string;
  roomId: string;
  threadId: string;
  runId: string | null;
  agentId: string | null;
  turnId: string | null;
  role: StoredMessageRole;
  kind: StoredMessageKind;
  content: string;
  parts: MessagePart[];
  sequence: number;
  createdAt: string;
  status: string;
  idempotencyKey: string | null;
}

export interface AppendMessageInput {
  messageId?: string;
  roomId: string;
  threadId: string;
  runId: string | null;
  agentId: string | null;
  turnId: string | null;
  role: StoredMessageRole;
  kind: StoredMessageKind;
  content: string;
  parts: MessagePart[];
  status: string;
  idempotencyKey: string;
  createdAt?: string;
}

export interface ConversationThread {
  id: string;
  roomId: string;
  isDefault: boolean;
  latestSequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMemoryStore {
  appendMessage(input: AppendMessageInput): Promise<ConversationStoredMessage>;
  listThreadMessages(
    threadId: string,
    options?: { afterSequence?: number; limit?: number },
  ): Promise<ConversationStoredMessage[]>;
  getLatestSequence(threadId: string): Promise<number>;
}
