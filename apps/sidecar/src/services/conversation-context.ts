import type { ConversationStoredMessage, RuntimeConversationMessage } from "@socrates/core";

export interface ConversationContextOptions {
  contextWindowTokens: number | null;
  outputReserveTokens?: number;
  instructionTokens?: number;
  /** Highest sequence omitted by the storage page before this builder ran. */
  omittedBeforeSequence?: number | null;
}

export interface ConversationContext {
  messages: RuntimeConversationMessage[];
  truncated: boolean;
  overflow: boolean;
  estimatedTokens: number;
  budgetTokens: number | null;
  droppedThroughSequence: number | null;
}

type MessageUnit = {
  messages: ConversationStoredMessage[];
  tokens: number;
};

// Provider tokenizers are not available at this layer. One UTF-8 byte per token
// is intentionally conservative (BPE token counts cannot exceed byte fallback)
// and prevents the estimator from sending an over-budget payload.
const tokenEstimate = (value: unknown): number =>
  Math.max(1, new TextEncoder().encode(JSON.stringify(value)).byteLength);

function messageTokens(message: ConversationStoredMessage): number {
  return 4 + tokenEstimate({
    role: message.role,
    content: message.content,
    parts: message.parts,
  });
}

function toolCallKey(message: ConversationStoredMessage): string | null {
  const callId = message.parts.find((part) => part.type === "tool_call")?.callId;
  if (!callId) return null;
  const scope = message.runId ?? message.turnId ?? `message:${message.messageId}`;
  return `${scope}:${callId}`;
}

function toolResultKey(message: ConversationStoredMessage): string | null {
  const callId = message.parts.find((part) => part.type === "tool_result")?.callId;
  if (!callId) return null;
  const scope = message.runId ?? message.turnId ?? `message:${message.messageId}`;
  return `${scope}:${callId}`;
}

/**
 * Storage paging, cancellation, or an interrupted sidecar can leave only one
 * side of a tool exchange in the loaded page. Provider APIs reject orphaned
 * tool results/calls, so product history keeps them for audit while model
 * context receives complete pairs only.
 */
function completeToolExchanges(messages: ConversationStoredMessage[]): ConversationStoredMessage[] {
  const pending = new Map<string, number[]>();
  const complete = new Set<number>();
  messages.forEach((message, index) => {
    const callKey = toolCallKey(message);
    if (callKey) {
      const indexes = pending.get(callKey) ?? [];
      indexes.push(index);
      pending.set(callKey, indexes);
    }
    const resultKey = toolResultKey(message);
    const indexes = resultKey ? pending.get(resultKey) : undefined;
    const callIndex = indexes?.shift();
    if (callIndex !== undefined) {
      complete.add(callIndex);
      complete.add(index);
      if (!indexes?.length) pending.delete(resultKey!);
    }
  });
  return messages.filter((message, index) =>
    (!toolCallKey(message) && !toolResultKey(message)) || complete.has(index));
}

/**
 * Groups a tool call with its result before truncation so a provider never
 * receives one side of a completed tool exchange.
 */
function messageUnits(messages: ConversationStoredMessage[]): MessageUnit[] {
  const calls = new Map<string, number>();
  const intervals: Array<{ start: number; end: number }> = [];
  messages.forEach((message, index) => {
    const callKey = toolCallKey(message);
    if (callKey) calls.set(callKey, index);
    const resultKey = toolResultKey(message);
    const callIndex = resultKey ? calls.get(resultKey) : undefined;
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
  if (options.contextWindowTokens === null) {
    const ordered = [...history].sort((left, right) => left.sequence - right.sequence);
    const pinned = ordered.filter((message) => message.role === "system");
    const conversational = completeToolExchanges(ordered.filter((message) => message.role !== "system"));
    const messages = [...pinned, ...conversational].sort((left, right) => left.sequence - right.sequence);
    return {
      messages: messages.map(toRuntimeMessage),
      truncated: Boolean(options.omittedBeforeSequence),
      overflow: false,
      estimatedTokens: messages.reduce((total, message) => total + messageTokens(message), 0),
      budgetTokens: null,
      droppedThroughSequence: options.omittedBeforeSequence ?? null,
    };
  }
  const contextWindow = Math.max(1, Math.floor(options.contextWindowTokens));
  const outputReserve = Math.max(
    1,
    Math.floor(options.outputReserveTokens ?? Math.min(4_096, contextWindow * 0.2)),
  );
  const instructionTokens = Math.max(0, Math.floor(options.instructionTokens ?? 0));
  const budgetTokens = Math.max(1, contextWindow - outputReserve - instructionTokens);
  const ordered = [...history].sort((left, right) => left.sequence - right.sequence);
  const pinned = ordered.filter((message) => message.role === "system");
  const conversational = completeToolExchanges(
    ordered.filter((message) => message.role !== "system"),
  );
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
  const omittedBeforeSequence = options.omittedBeforeSequence && options.omittedBeforeSequence > 0
    ? options.omittedBeforeSequence
    : null;
  const droppedThroughSequence = [
    omittedBeforeSequence,
    ...(dropped.length ? [Math.max(...dropped.map((message) => message.sequence))] : []),
  ].filter((value): value is number => value !== null);
  return {
    messages: retained.map(toRuntimeMessage),
    truncated: dropped.length > 0 || omittedBeforeSequence !== null,
    overflow: used > budgetTokens,
    estimatedTokens: used,
    budgetTokens,
    droppedThroughSequence: droppedThroughSequence.length
      ? Math.max(...droppedThroughSequence)
      : null,
  };
}
