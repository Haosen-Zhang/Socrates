# ADR 0006: Execution event journal and recovery

- Status: Accepted; Phase 1A execution authority implemented, live SSE projection pending
- Date: 2026-07-16
- Updated: 2026-08-21

## Decision

`runtime_events` is the sole authority for normalized single-Agent execution
facts. Every Run has an append-only sequence and every event has a globally
stable ID. The envelope carries `sessionId`, `runId`, `agentId`, optional
Turn/Step/provider-attempt/tool-operation/tool-attempt identities, a schema
version, payload, and occurrence time.

Event append, `agent_runs.event_seq`, and any projection callback supplied to
the store commit in the same SQLite transaction; consumers see only committed
events. Reducers accept the next sequence, ignore duplicates, and request replay
on a gap. Reusing an event ID with different content is a protocol error.

Conversation and execution authority remain separate:

- append-only `room.jsonl` HistoryStore owns public and model-visible content;
- `runtime_events` owns single-Agent execution facts and normalized Runtime
  output used for runtime/audit projections;
- `task_events` continues to own existing Session and Multi-Agent domain
  events until those paths receive an explicit migration.

Execution events must never be replayed into model history. UI and audit
projections may be rebuilt from them after Phase 1C adds cursor-based delivery.

Streaming deltas are checkpointed in bounded chunks instead of persisting every token. Stable task/turn/tool keys prevent duplicate execution. A duplicate stable key with a different input hash is a protocol violation. Unknown non-idempotent outcomes become explicit interrupted/unknown states and are never automatically retried.

Schema evolution uses forward-only, checksum-validated migrations inside `BEGIN IMMEDIATE`. Existing file databases receive a consistent `VACUUM INTO` backup before pending migrations.

Migration 017 extends legacy `runtime_events` rows without deleting them,
marks every pre-migration row as legacy schema v0, backfills `session_id` where
an owning `agent_runs` row exists, and reserves versioned projection
checkpoints. Legacy rows are retained for forensic inspection but are never
misinterpreted or exposed as typed v1 events. A Run with a legacy prefix is
quarantined from v1 append, so typed reducers never receive a false sequence
baseline or a mixed-schema stream.

## Phase boundaries

Phase 1A emits Run lifecycle, cancellation, interruption, approval, context
truncation, and normalized Runtime events. The event vocabulary also fixes the
future Provider and Tool attempt identity contract, but those attempt events are
not emitted until the Provider/Tool execution loop is migrated.

Phase 1A does not make a Run independent of the request that started it, detach
live SSE from execution, recover an in-flight Tool side effect, or change SDK
retry behavior. Those remain Phase 1B and later work. Terminal HistoryStore and
execution-journal writes are deliberately separate authorities. On startup,
Phase 1A deterministically repairs a missing terminal or approval-decision event
from committed relational evidence; Phase 1B moves that reconciliation under
the independent Run supervisor.
