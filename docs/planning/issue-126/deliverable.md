# Ticket #126 delivery

Implemented a local append-only `HistoryStore` at
`<Socrates data dir>/history/<sessionId>/room.jsonl`, with strict per-Session
ordering, SHA-256 chaining, durable append, a rebuildable SQLite projection,
legacy Session export, startup reconciliation, rewind epochs, and Session-local
read-only recovery. Typed projection intents make the SQLite side effects for
Turn creation/completion, MultiTask creation, and rewind cleanup restart-safe;
an fsynced deletion tombstone keeps Session removal crash-consistent.

The production Session runtime paths now route user, assistant, tool,
Multi-Agent, execution, rewind, and deletion operations through HistoryStore.
Task/Run/Turn/approval/lease authority remains in SQLite as required by
ADR-0008. HIST-002 search/FTS, semantic Memory, compaction, and legacy `/rooms`
migration are intentionally deferred to their approved downstream tickets.

Verification: `bun test` (543 passed, 2 platform skips), `bun run typecheck`,
`bun run lint`, `bun run --cwd apps/desktop build`, and an isolated sidecar
startup/handshake smoke test all passed. The existing Vite chunk-size and mixed
static/dynamic import warnings remain non-blocking and unchanged in scope.
