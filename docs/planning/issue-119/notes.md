# Notes: ADR-008 context and memory authority

## Approved source

- `/Users/haosen/Documents/SocratesDesignPlan/socrates-context-memory-implementation-plan.md`
- Baseline: `main@7a1245069feb357a65e5ff149cea9baf6b83ddee`.

## Findings

- ADR-0004 already establishes Socrates as product Session and recovery
  authority; external runtimes own only protocol sessions.
- ADR-0005 keeps model text separate from approval and allows only one designated
  execution Agent to hold the workspace write lease.
- ADR-0006 owns durable runtime event sequencing in SQLite. Conversation JSONL
  must not displace Task, approval, lease, Run, or domain-event authority.
- ADR-0003 is historical MVP scope. Only unconditional full-history forwarding
  is partially superseded after migration gates; its no-blackboard rationale is
  retained.
- The approved plan requires one shared HistoryStore writer, traceable Memory,
  offline archives, Agent-private context isolation, and no guessed limits.

## Review checklist

- Standards axis: documentation-only scope, existing ADR vocabulary, one Ticket
  and one branch, and no runtime or schema changes.
- Specification axis: single authority per fact, gated authority transition,
  immutable catalog provenance, unavailable unknown limits, traceable
  compaction, ToolResult isolation, and Agent/child-session boundaries.
- No blocking review findings remain.

- Authority table separates conversation history, runtime state, payloads,
  Memory projection, catalog cache, and archives.
- Transition gate prevents JSONL and SQLite from becoming parallel writers.
- Tool results, child sessions, Charter, and private traces have explicit
  isolation rules.
- Ticket DAG prevents semantic compaction before source history and Memory
  pointers exist.
