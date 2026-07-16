# ADR 0004: Agent Runtime ownership boundary

- Status: Accepted; foundation implemented, adapters incomplete
- Date: 2026-07-16

## Decision

Socrates owns sessions, modes, tasks, event sequence, agent snapshots, approvals, plan versions, usage projections and recovery state. Runtime adapters own only their external process/protocol session. An external runtime ID is a recoverable mapping, never the product primary key.

Native AI SDK remains the text/chat and read-only path. The first write/shell implementation must be the pinned Codex app-server adapter. No provider adapter may access the filesystem directly, and no arbitrary native shell is released before an isolated command worker satisfies the security definition of done.

Runtime events are normalized and committed to the Socrates event journal before UI delivery. Unknown adapter fields remain opaque extension payloads. A restart without authoritative resume marks active runtime mappings `interrupted`; it does not replay a non-idempotent operation.

## Consequences

The core `AgentRuntime` contract is intentionally richer than the existing one-shot `ModelGateway`. Existing Room APIs remain a compatibility adapter while new work uses SessionStore.
