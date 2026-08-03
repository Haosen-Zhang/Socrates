# Task Plan: ADR-008 context and memory authority

## Goal

Document the approved authority, isolation, and migration boundaries that gate
the context catalog, durable history, memory, compaction, and subagent tickets.

## Phases

- [x] Phase 1: Confirm #118 merge and create Ticket #119 worktree.
- [x] Phase 2: Audit current domain vocabulary and relevant ADRs.
- [x] Phase 3: Draft ADR-0008 and narrowly link ADR-0003.
- [x] Phase 4: Review the decision against the approved implementation plan.
- [x] Phase 5: Run documentation/repository gates.
- [ ] Phase 6: Commit, push, and create the independent PR.

## Key questions

1. Which store is authoritative for conversation content versus runtime state?
2. Which parts of ADR-0003 are superseded, and only when?
3. What ordering prevents parallel authorities or private-context leakage?

## Decisions

- This ticket changes architecture documentation only.
- Runtime implementation follows the approved Ticket DAG after this PR merges.

## Errors encountered

- None.

## Status

**Currently in Phase 6** — committing and publishing the independent PR.
