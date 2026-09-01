# ADR 0006: Execution event journal and recovery

- Status: Accepted; Phase 1A–1C and Phase 2 Provider retry implemented
- Date: 2026-07-16
- Updated: 2026-09-01

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
projections can be rebuilt through cursor-based delivery.

Single-Agent Run lifetime is owned by a sidecar `RunSupervisor`, not by the
HTTP request or SSE observer. Starting a Run, observing its durable events,
reading its durable status projection, and explicitly cancelling it are
separate operations. Every supervised Run has its own `AbortController`.
Observer failure only detaches that observer; explicit cancellation or
controlled sidecar shutdown owns abortion.

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

Phase 1B separates create/start from observation and moves startup
reconciliation under the independent supervisor. Phase 1C removes the bounded
in-process hand-off buffer: `GET /agent/runs/:runId/events?afterSeq=N` reads
committed events by sequence, uses the durable sequence as the SSE ID, then waits
for later commits without making observer speed part of execution flow control.
The Desktop reconnects from its last confirmed sequence, rejects gaps and
identity mismatches, and rebuilds a fresh WebView projection from sequence zero.

Terminal HistoryStore and execution-journal writes remain deliberately separate
authorities. On startup, deterministic reconciliation repairs a missing terminal
or approval event from committed relational evidence. Recovering an in-flight
Tool side effect remains later-phase work.

Phase 2 disables opaque AI SDK retries (`maxRetries: 0`) and places the finite
single-Agent Provider retry policy above the adapter. It permits at most five
attempts for classified transient failures, honors a capped `Retry-After`, and
stops automatic replay once authoritative text or Tool activity begins. Stable
structured errors carry code, category, phase, retryability, optional retry
delay, and a bounded cause. Retry lifecycle is durably retained as normalized
Runtime extension events until Phase 3 can attach canonical Step and
ProviderAttempt coordinates.
