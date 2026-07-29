import type { ConversationStoredMessage, RuntimeConversationMessage } from "@socrates/core";

export interface ConversationContextOptions {
  contextWindowTokens: number;
  outputReserveTokens?: number;
  instructionTokens?: number;
}

export interface ConversationContext {
  messages: RuntimeConversationMessage[];
  truncated: boolean;
  estimatedTokens: number;
  budgetTokens: number;
  droppedThroughSequence: number | null;
}

type MessageUnit = {
  messages: ConversationStoredMessage[];
  tokens: number;
};

const tokenEstimate = (value: unknown): number =>
  Math.max(1, Math.ceil(new TextEncoder().encode(JSON.stringify(value)).byteLength / 4));

function messageTokens(message: ConversationStoredMessage): number {
  return 4 + tokenEstimate({
    role: message.role,
    content: message.content,
    parts: message.parts,
  });
}

function toolCallId(message: ConversationStoredMessage): string | null {
  return message.parts.find((part) => part.type === "tool_call")?.callId ?? null;
}

function toolResultId(message: ConversationStoredMessage): string | null {
  return message.parts.find((part) => part.type === "tool_result")?.callId ?? null;
}

/**
 * Groups a tool call with its result before truncation so a provider never
 * receives one side of a completed tool exchange.
 */
function messageUnits(messages: ConversationStoredMessage[]): MessageUnit[] {
  const calls = new Map<string, number>();
  const intervals: Array<{ start: number; end: number }> = [];
  messages.forEach((message, index) => {
    const callId = toolCallId(message);
    if (callId) calls.set(callId, index);
    const resultId = toolResultId(message);
    const callIndex = resultId ? calls.get(resultId) : undefined;
    if (callIndex !== undefined) intervals.push({ start: callIndex, end: index });
  });
  intervals.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  const intervalByStart = new Map(merged.map((interval) => [interval.start, interval]));

  const units: MessageUnit[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const interval = intervalByStart.get(index);
    if (interval) {
      const grouped = messages.slice(interval.start, interval.end + 1);
      units.push({
        messages: grouped,
        tokens: grouped.reduce((total, message) => total + messageTokens(message), 0),
      });
      index = interval.end;
      continue;
    }
    const message = messages[index]!;
    units.push({ messages: [message], tokens: messageTokens(message) });
  }
  return units;
}

function toRuntimeMessage(message: ConversationStoredMessage): RuntimeConversationMessage {
  return {
    messageId: message.messageId,
    role: message.role,
    content: message.content,
    parts: message.parts,
    sequence: message.sequence,
  };
}

/**
 * First-stage context policy: keep all product instructions and the newest
 * complete conversation units within a model-aware token budget. It does not
 * summarize or invent memory.
 */
export function buildConversationContext(
  history: ConversationStoredMessage[],
  options: ConversationContextOptions,
): ConversationContext {
  const contextWindow = Math.max(1, Math.floor(options.contextWindowTokens));
  const outputReserve = Math.max(
    1,
    Math.floor(options.outputReserveTokens ?? Math.min(4_096, contextWindow * 0.2)),
  );
  const instructionTokens = Math.max(0, Math.floor(options.instructionTokens ?? 0));
  const budgetTokens = Math.max(1, contextWindow - outputReserve - instructionTokens);
  const ordered = [...history].sort((left, right) => left.sequence - right.sequence);
  const pinned = ordered.filter((message) => message.role === "system");
  const conversational = ordered.filter((message) => message.role !== "system");
  const units = messageUnits(conversational);
  const pinnedTokens = pinned.reduce((total, message) => total + messageTokens(message), 0);
  let used = pinnedTokens;
  const selected: MessageUnit[] = [];

  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index]!;
    if (selected.length > 0 && used + unit.tokens > budgetTokens) break;
    selected.unshift(unit);
    used += unit.tokens;
  }

  const retained = [...pinned, ...selected.flatMap((unit) => unit.messages)]
    .sort((left, right) => left.sequence - right.sequence);
  const retainedIds = new Set(retained.map((message) => message.messageId));
  const dropped = ordered.filter((message) => !retainedIds.has(message.messageId));
  return {
    messages: retained.map(toRuntimeMessage),
    truncated: dropped.length > 0,
    estimatedTokens: used,
    budgetTokens,
    droppedThroughSequence: dropped.length
      ? Math.max(...dropped.map((message) => message.sequence))
      : null,
  };
}
