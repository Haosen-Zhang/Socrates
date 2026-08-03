# ADR 0008: Context, history, and memory authority

- Status: Accepted; implementation pending
- Date: 2026-08-03
- Supersedes: ADR-0003 only for unconditional full-history forwarding after
  the migration gates in this ADR are complete

## Context

Socrates already owns durable Session, Turn, ToolCall, approval, usage, event,
and workspace state. Its product-visible conversation is currently projected in
SQLite and reconstructed for a Provider from bounded message rows. The current
context path can discard old rows when a known model limit is reached, while an
unknown model receives a guessed fallback. The Multi-Agent checkpoint is an
extractive character slice rather than a traceable semantic compaction.

Long-running Rooms require four properties that unconditional full-history
forwarding cannot provide:

1. the complete user-visible transcript must remain locally durable and
   auditable after compaction or rewind;
2. every model call must use a model-specific, provenance-bearing context
   budget without guessing unknown limits;
3. recalled memory and compressed history must be traceable to original records;
4. shared Room history, Agent-private execution context, and child sessions must
   not leak into one another.

This decision deepens the existing Socrates Runtime and storage seams. It does
not authorize a parallel Runtime, a vector database, concurrent workspace
writers, or a Provider-owned product transcript.

## Decision

### Authority

Socrates assigns one authority to each class of fact:

| Fact | Authority | Projection or cache |
| --- | --- | --- |
| Public conversation content and order | append-only `room.jsonl` HistoryStore | SQLite messages, FTS5, UI lists |
| Agent-private execution trace | per-Agent trace JSONL | user-visible trace projection |
| Task, Run, Turn, approval, lease, recovery, and domain events | SQLite | renderer and runtime projections |
| Large tool output and attachment bytes | content-addressed payload store | hash, size, and storage key in HistoryRecord |
| Current Memory and Charter views | SQLite projection | source mutations remain in HistoryStore |
| Model catalog response | verified app-data cache | immutable resolution snapshot on Agent and Turn |
| Compaction summary | immutable archive linked to source range | pointer and selected Memory enter context |

`session_messages` becomes a rebuildable projection only after HIST-001 has
implemented append, reconciliation, migration, and recovery. Until that gate is
complete, the existing SQLite conversation path remains authoritative. There is
never a supported state in which JSONL and SQLite independently accept public
conversation writes.

### History write protocol

HistoryStore is the only writer of shared `room.jsonl`. It serializes writes per
Session, allocates a strict sequence, appends one hash-chained record with
`O_APPEND`, and durably syncs it before updating SQLite projections in one
transaction. SSE delivery occurs only after the projection commits.

On restart, a reconciler resumes from a committed projected offset. A final
partial line may be repaired. A complete record with an invalid hash places the
Session in read-only recovery; it is never silently skipped. Stable record IDs
make retries idempotent.

Rewind appends a new-epoch record and changes the active projection. It does not
delete historical records. Physical transcript and payload deletion occurs only
when the user deletes the entire Session through the product's deletion policy.

### Context assembly

One `ContextAssembler` builds every Provider request. It consumes an immutable
`ContextWindowResolution`, system and role instructions, Room policy, Charter,
selected Memory, recent complete turns, legal history pointers, the current work
unit, and the current Agent-loop tool exchange.

The model context window resolution has four values:

- `catalogValue`: exact value resolved from the configured catalog mapping;
- `userOverride`: explicit user value or null;
- `effectiveValue`: `userOverride ?? catalogValue`;
- `source`: `user_override`, `catalog`, or `unavailable`.

Provider and model matching must be explicit or an unambiguous exact API-origin
mapping. Model-name similarity across Providers is not evidence. Existing Agent
snapshots and every Turn freeze the resolution they actually used. Unknown
models remain runnable for short conversations but have no guessed limit, no
percentage, and no proactive compaction.

### Compaction and recall

When the effective model limit is known, ContextAssembler reserves the actual
maximum output budget and a bounded safety buffer. Below the high-water mark it
uses eligible original conversation turns. Above it, ContextCompactor selects
oldest complete turn units while retaining at least the two most recent complete
turns within a bounded recent budget.

Compaction produces:

- structured Memory mutations with valid `history://` source pointers;
- an immutable offline archive linked to the exact source range and previous
  archive;
- a compact history-range pointer for on-demand recovery.

The archive itself is not automatically inserted into later prompts. Context
contains selected Memory, pointers, and recent original turns. FTS5/BM25 search
and bounded around-read can recover original JSONL records on demand. Switching
to a model with a larger limit may allow ContextAssembler to use the original
history again.

A Provider context-overflow response may trigger one forced compaction and one
retry only when no assistant delta or ToolCall has been emitted. Once external
output exists, automatic replay is forbidden. A current work unit that cannot
fit fails before Provider invocation.

### Tool-result isolation

The current Agent loop receives a newly produced ToolResult exactly once so it
can continue sampling. The complete result remains in HistoryStore or the
payload store. On a later user Turn, old ToolCall and ToolResult protocol messages
are not automatically replayed. They are represented by bounded metadata and a
history or payload pointer, and their body is available only through an explicit
bounded read.

Tool result bodies do not enter Memory extraction, compaction prompts, or FTS.
This prevents repeated context inflation and Provider-invalid orphan ToolCalls.

### Memory and Charter

Memory is a traceable index, not a fact authority. Every item has scope, owner,
status, confidence, priority, and at least one valid HistoryPointer. Failed
extraction cannot invent Memory or make source history eligible for eviction.
Explicit user memory outranks inferred memory.

Charter contains only user decisions, user constraints or negations, approved
plan facts, and Coordinator-accepted consensus. RoomMemoryCoordinator is its
single writer. Every Charter mutation increments a version and appends a public
HistoryRecord.

Cross-Session recall is bounded to an authorized Workspace or Agent scope by
default. History content is data, never system instruction.

### Multi-Agent and child-session isolation

The Room Coordinator is the single writer of public Room history. Each Agent
receives an independently assembled context package based on its own frozen model
limit. Agent-private Memory and trace are visible only to that Agent and the
user. Another Agent never receives them through shared context.

Subagents run in child Sessions. Parents pass typed TaskPackets containing only
approved constraints and references; children return typed ResultPackets.
Parent context arrays, child messages, ToolResults, traces, and hidden reasoning
are not copied across the boundary.

Multi-Agent discussion and synthesis remain read-only. Only the approved
execution Agent may hold the existing workspace write lease. Path claims and
conflict checks may be added later, but they do not replace concrete Tool
approval and do not authorize parallel writers in a shared working tree.

### Migration order and release gates

Implementation must follow this dependency order, one independently reviewed
Ticket and PR at a time:

1. CAT-001: catalog provenance, Agent snapshots, migration, and removal of
   guessed context limits;
2. HIST-001: JSONL journal, projection migration, reconciliation, and recovery;
3. HIST-002: scoped FTS5/BM25, around-read, history tools, and paged file reads;
4. MEM-002: idempotent Memory jobs, source validation, and bounded recall;
5. CMP-001: ContextAssembler, semantic compaction, archives, and one-shot
   overflow recovery;
6. MULTI-MEM-001: shared/private Room memory and Charter;
7. SUB-001: isolated child Sessions and ResultPackets;
8. CLAIM-001: declared write paths and execution-time conflict enforcement;
9. CHAT-002: migrate legacy Room APIs to the same Session/History authority;
10. UI-CTX-001: context, Memory, archive, Charter, and source diagnostics.

No later Ticket may bypass an unmet dependency by adding a temporary second
store, fake UI capability, guessed limit, or untraceable summary.

## Invariants

- One fact has one authority; projections are rebuildable and do not accept
  independent writes.
- No hidden chain-of-thought is persisted. Only public reasoning summaries may
  be stored.
- Every Memory and Charter item resolves to original History records.
- Compaction never modifies or deletes source history.
- A complete ToolCall/ToolResult unit is never split by paging or compaction.
- Old ToolResult bodies never enter a later Turn automatically.
- Unknown context limits remain unavailable and are never guessed.
- Different Agents never inherit another Agent's context limit or private trace.
- Plan approval remains separate from exact Tool approval.
- Only one designated execution Agent writes the shared Workspace.

## Consequences

Positive consequences:

- long-running Rooms can remain locally complete while Provider prompts stay
  bounded and auditable;
- model-specific limits and user overrides become explicit product data;
- compacted knowledge can be verified and original history recovered on demand;
- Multi-Agent and child-session context boundaries become enforceable rather
  than prompt conventions.

Costs and risks:

- append/reconcile/projection ordering and migration require crash-consistency
  tests before authority can move from SQLite messages;
- semantic Memory and compaction add Provider cost and failure modes, so source
  history must remain usable when extraction fails;
- catalog metadata can be stale or unavailable and must expose provenance;
- FTS, payload retention, and local history deletion need explicit lifecycle and
  recovery behavior.

## Out of scope

- embeddings or a vector database;
- Provider-owned or LangGraph-owned product history;
- storing hidden chain-of-thought;
- unbounded global memory retrieval;
- arbitrary glob write claims;
- concurrent writers in one shared Workspace;
- reintroducing local Codex CLI or a second Agent Runtime.
