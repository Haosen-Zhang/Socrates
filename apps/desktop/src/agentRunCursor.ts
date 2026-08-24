const ACTIVE_AGENT_RUN_KEY = "socrates.active-agent-run.v1";

export interface AgentRunCursor {
  sessionId: string;
  runId: string;
  afterSeq: number;
}

export interface CursorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function selectActiveAgentRunCursor(
  persisted: AgentRunCursor | null,
  inMemory: { sessionId: string; runId: string } | null,
): AgentRunCursor | null {
  return inMemory ? { ...inMemory, afterSeq: 0 } : persisted;
}

export function readActiveAgentRunCursor(storage: CursorStorage): AgentRunCursor | null {
  try {
    const raw = storage.getItem(ACTIVE_AGENT_RUN_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.sessionId !== "string" || !value.sessionId
      || typeof value.runId !== "string" || !value.runId
      || !Number.isSafeInteger(value.afterSeq) || (value.afterSeq as number) < 0) return null;
    return value as unknown as AgentRunCursor;
  } catch {
    return null;
  }
}

export function writeActiveAgentRunCursor(
  storage: CursorStorage,
  cursor: AgentRunCursor,
): boolean {
  try {
    storage.setItem(ACTIVE_AGENT_RUN_KEY, JSON.stringify(cursor));
    return true;
  } catch {
    return false;
  }
}

export function advanceActiveAgentRunCursor(
  storage: CursorStorage,
  cursor: AgentRunCursor,
): boolean {
  const current = readActiveAgentRunCursor(storage);
  if (!current
    || current.sessionId !== cursor.sessionId
    || current.runId !== cursor.runId
    || current.afterSeq > cursor.afterSeq) return false;
  return writeActiveAgentRunCursor(storage, cursor);
}

export function clearActiveAgentRunCursor(storage: CursorStorage, runId: string): void {
  if (readActiveAgentRunCursor(storage)?.runId === runId) {
    try {
      storage.removeItem(ACTIVE_AGENT_RUN_KEY);
    } catch {
      // An unavailable persistence layer must not alter the in-memory Run owner.
    }
  }
}
