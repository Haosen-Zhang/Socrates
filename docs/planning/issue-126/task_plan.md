# Task Plan: HIST-001 durable HistoryStore

## Goal

Move public Session conversation authority to an append-only local JSONL journal
with a rebuildable SQLite projection and deterministic crash recovery.

## Phases

- [x] Phase 1: Confirm dependencies, create #126, branch, and worktree.
- [x] Phase 2: Audit current message, rewind, deletion, and startup paths.
- [x] Phase 3: Add core history contracts and HistoryStore tests.
- [x] Phase 4: Implement journal append, projection, migration, and reconcile.
- [x] Phase 5: Integrate runtime writes, rewind, deletion, and startup recovery.
- [x] Phase 6: Review, run full gates, and prepare the reviewed PR change set.

## Key invariants

- JSONL sync succeeds before the SQLite projection commits.
- One Session queue allocates strict sequence and hash order.
- A final partial line is repairable; a complete bad hash is read-only recovery.
- Existing Session data is exported before authority changes.
- FTS, Memory, and compaction remain out of scope.

## Status

**Complete** — two independent reviews approved the final change set; repository
gates and the isolated sidecar startup smoke test pass.
