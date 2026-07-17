# ADR 0006: Event journal and recovery

- Status: Accepted; durable replay foundation implemented, live SSE projection pending
- Date: 2026-07-16

## Decision

Each session has an append-only event sequence and globally unique event IDs. Event append and projection update occur in the same SQLite transaction; consumers see only committed events. Reducers accept the next sequence, ignore duplicates and request replay on a gap.

Streaming deltas are checkpointed in bounded chunks instead of persisting every token. Stable task/turn/tool keys prevent duplicate execution. A duplicate stable key with a different input hash is a protocol violation. Unknown non-idempotent outcomes become explicit interrupted/unknown states and are never automatically retried.

Schema evolution uses forward-only, checksum-validated migrations inside `BEGIN IMMEDIATE`. Existing file databases receive a consistent `VACUUM INTO` backup before pending migrations.
