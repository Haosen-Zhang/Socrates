# HIST-001 notes

## Approved source

- `/Users/haosen/Documents/SocratesDesignPlan/socrates-context-memory-implementation-plan.md`
- `docs/adr/0008-context-history-memory-authority.md`

## Findings

- `ConversationMemoryStore` owned the sequenced Single-Agent path, while
  Multi-Agent and execution summaries wrote `session_messages` directly.
- `SessionStore.rewind` physically deleted messages; HIST-001 replaces this in
  production wiring with an append-only rewind epoch plus active projection.
- Session deletion is the only operation that physically removes `room.jsonl`.
- The legacy `/rooms` API remains SQLite-backed by design and is migrated in
  the separately planned CHAT-002 ticket; this ticket does not create a second
  journal for that legacy API.
- Two-axis review found and this branch corrected queue bypass, globally scoped
  record IDs, incomplete writes, missing directory sync, lost-tail acceptance,
  interrupted export loss, projection-only rebuild gaps, Room-wide rewind
  leakage, and non-durable Session deletion.
- Public reasoning summaries are persisted; hidden chain-of-thought is not.

## Recovery behavior

- A final partial JSON line is truncated only beyond the committed checkpoint.
- A complete bad hash or a missing committed tail isolates only that Session in
  `recovery`; `bootstrapAll` continues loading healthy Sessions.
- JSONL-success/SQLite-failure is retried from the journal. Stable Turn IDs let
  a failed Turn projection retry without appending the user message twice.
- Typed projection intents replay Turn, MultiTask, and rewind domain updates
  after a process exits between the journal sync and SQLite commit.
- Reconciliation validates schema version, Session and Thread ownership,
  contiguous sequence, hash chain, and exact existing message identity.
- Deleting only `session_messages` and `message_parts` triggers deterministic
  reconstruction from the validated journal and replayed rewind epochs.
- Session deletion first renames the journal into an fsynced tombstone. Startup
  restores it when SQLite rolled back or finalizes removal after SQLite commit.
