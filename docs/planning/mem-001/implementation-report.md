# MEM-001 Implementation Report

## Outcome

Single-Agent rooms now use Socrates' local SQLite database as the authoritative
same-Thread memory source. Every Turn persists the user input before sampling,
reloads the durable Thread transcript, sends that transcript through the
provider-neutral Runtime contract, and persists the final assistant response and
structured tool exchanges.

The implementation does not use a local Codex executable, `CODEX_HOME`,
LangGraph checkpoint state, or UI-only Zustand state as conversation memory.

## Data model

Migration 011 adds:

- `sessions.primary_agent_id`;
- one durable default `conversation_threads` row per existing Room;
- `conversation_turns` with stable client keys, input hashes, attempts,
  terminal status, and context diagnostics;
- Thread/Run/Turn/Agent/kind/sequence/idempotency metadata on
  `session_messages`;
- strict per-Thread sequence and idempotency indexes;
- deterministic backfill for existing Rooms and messages.

`ConversationMemoryStore` owns append/list/latest-sequence operations and
atomic Turn preparation. Failed or interrupted Turn retries create a new run
attempt without duplicating the user message. Replaying a completed client Turn
does not call the provider again.

## Runtime flow

The Single-Agent path now performs:

1. resolve the persisted `primaryAgentId`;
2. resolve or create the Room's default Thread;
3. atomically create/retry the Turn and persist its user message;
4. reload ordered Thread messages from SQLite;
5. apply a model-aware token budget without splitting tool call/result groups;
6. convert product messages to provider-neutral Runtime messages and then AI SDK
   `ModelMessage` values;
7. persist tool calls, tool results, and the final assistant message;
8. persist terminal Run/Turn/Room state.

The Desktop supplies a stable `clientTurnKey` for command idempotency. The SSE
protocol now recognizes normalized `tool_result` events.

## Context policy

The first-stage policy keeps system instructions and the newest complete
conversation units. It estimates tokens from UTF-8 payload size, reserves output
capacity, and records `memory.context_truncated` with the budget and last dropped
sequence. Completed tool exchanges, including interleaved parallel calls, are
kept or removed atomically.

No summary, embeddings, vector database, RAG memory, profile extraction, or
cross-Room memory was added.

## Tests added

Coverage includes:

- second Turn receives first user and assistant messages;
- persistence across database/runner reopen;
- Room and Thread isolation;
- final assistant persistence;
- tool call/result persistence into the next sample;
- completed command replay and failed Turn retry idempotency;
- explicit primary Agent independent of member position;
- cancellation retains confirmed history without a fake assistant completion;
- strict ordering, migration/backfill, and rewind sequence reuse;
- token-limit truncation diagnostics and atomic tool pairing;
- operation with an empty `PATH` and a nonexistent `CODEX_HOME`.

## Verification

- `bun test`: 380 passed, 0 failed before final review.
- `bun run typecheck`: passed.
- `bun run --cwd apps/desktop build`: passed.
- Biome on all 23 changed TS/TSX files: passed.
- Repository-wide lint still reports seven pre-existing findings in untouched
  files; they are outside this Ticket.

## Safety and compatibility

- Migration is additive and runs through the existing checksum/backup path.
- Existing messages are preserved and backfilled in deterministic order.
- API keys and hidden chain-of-thought are never stored in message memory.
- Tool output remains bounded to the existing persisted preview representation.
- The existing LangGraph adapter is not registered or made authoritative.
- Existing Chat and Multi-Agent runtime behavior is unchanged.

## Known limits

- Token counts are deterministic estimates, not provider tokenizer output.
- Over-budget history is truncated; automatic old-message summarization is
  intentionally deferred.
- The current product UI uses one default Thread per Room; the storage/runtime
  contract already isolates additional Thread IDs for future UI work.
- Packaged Tauri smoke testing is not automated in this repository.
