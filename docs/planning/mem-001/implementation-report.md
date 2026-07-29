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
5. resolve local text attachments and workspace references inside the workspace
   boundary, verify reference snapshots, and then apply a model-aware token
   budget;
6. convert product messages to provider-neutral Runtime messages and then AI SDK
   `ModelMessage` values;
7. persist tool calls, tool results, and the final assistant message;
8. atomically persist the final assistant message with terminal
   Run/Turn/Room state.

The Desktop supplies a stable `clientTurnKey` for command idempotency. The SSE
protocol now recognizes normalized `tool_result` events.

## Context policy

The first-stage policy keeps system instructions and the newest complete
conversation units. It uses a conservative UTF-8-byte upper bound when a
provider tokenizer is unavailable, reserves output capacity, and records
`memory.context_truncated` with the budget and last dropped sequence. Completed
tool exchanges, including interleaved parallel calls, are kept or removed
atomically; orphaned calls/results left by paging or cancellation are excluded
from provider context without deleting the product audit record. Local text
attachments and `@path` references are expanded before this calculation, so
their contents cannot bypass the budget. If the current work unit alone exceeds
the budget, the Turn fails before any provider request rather than silently
dropping current work.

`@path` messages carry a content-addressed attachment snapshot captured before
Turn creation. Later edits to the live workspace file or refreshes of the path
reference cannot rewrite old model context. The runtime's actual system prompt
and available tool names/descriptions/schemas are included in the conservative
budget before sampling.

Agent configuration accepts an optional context-window token count and stores it
in the model capability snapshot. Unknown models use a conservative 4,096-token
fallback rather than an invented provider limit.

No summary, embeddings, vector database, RAG memory, profile extraction, or
cross-Room memory was added.

## Tests added

Coverage includes:

- second Turn receives first user and assistant messages;
- persistence across database/runner reopen;
- Room and Thread isolation;
- final assistant persistence;
- tool call/result persistence into the next sample;
- provider-valid exclusion of orphaned tool calls/results;
- Run-scoped tool pairing when providers reuse a call ID;
- local text attachment and workspace-reference resolution before sampling;
- immutable `@path` snapshots across later live-file changes;
- over-budget local attachment refusal before the provider is called;
- completed command replay and failed Turn retry idempotency;
- explicit primary Agent independent of member position;
- cancellation retains confirmed history without a fake assistant completion;
- a separate cancel request aborts the active provider signal and persists
  already displayed partial text with `cancelled` status;
- final assistant/terminal-state transaction rollback;
- strict ordering, migration/backfill, and rewind sequence reuse;
- token-limit truncation diagnostics and atomic tool pairing;
- operation with an empty `PATH` and a nonexistent `CODEX_HOME`.

## Verification

- `bun test`: 394 passed, 0 failed after review fixes.
- `bun run typecheck`: passed.
- `bun run --cwd apps/desktop build`: passed.
- Biome on all 34 changed TS/TSX files: passed.
- Repository-wide lint still reports seven pre-existing findings in untouched
  files; they are outside this Ticket.

## Safety and compatibility

- Migration is additive and runs through the existing checksum/backup path.
- Existing messages are preserved and backfilled in deterministic order.
- API keys and hidden chain-of-thought are never stored in message memory.
- Expanded local file contents are sent to the active model request only; the
  durable message keeps opaque attachment/reference records rather than copying
  file contents or absolute local paths.
- Workspace references are resolved through `WorkspacePathPolicy`, copied into
  the existing content-addressed attachment store, and integrity checked.
- Client-supplied context-window overrides are discarded; the persisted Agent
  capability is authoritative.
- Tool output remains bounded to the existing persisted preview representation.
- The existing LangGraph adapter is not registered or made authoritative.
- Existing Chat and Multi-Agent execution runtimes are unchanged. Co-work room
  creation now persists an explicitly selected default execution Agent instead
  of deriving it from `agentIds[0]`.

## Review disposition

The required Standards fix (`doc/architecture.md`) and both rounds of Spec
findings were addressed before delivery. Larger separation of `SingleAgentRunner`,
rewind orchestration, and Turn/Run persistence remains a maintainability
suggestion rather than a correctness blocker; this Ticket avoids a broad
runtime refactor.

## Known limits

- Token counts use a deterministic conservative bound, not exact provider
  tokenizer output.
- Image input remains explicitly unsupported by the current Native runtime; it
  is not silently dropped.
- Over-budget history is truncated; automatic old-message summarization is
  intentionally deferred.
- Thread history reads are bounded to the newest 10,000 stored messages and
  record that earlier sequences were omitted.
- The current product UI uses one default Thread per Room; the storage/runtime
  contract already isolates additional Thread IDs for future UI work.
- Packaged Tauri smoke testing is not automated in this repository.
