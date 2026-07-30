# Task Plan: UI-001 Room Creation

## Goal

Reduce room creation to name, workspace, and Agent members while ensuring every
new room has a stable workspace, an explicit primary Agent, and a runnable first
turn even when model context metadata is unknown.

## Public Test Seams

- `SessionStore` and the Sessions HTTP API.
- Workspace Manager/API for managed and existing roots.
- `SingleAgentRunner` with a recording runtime.
- Desktop room-creation modal behavior through its public form helpers/UI.

## Phases

- [x] Phase 1: Create Ticket #95, independent branch, worktree, and durable plan.
- [x] Phase 2: Record baseline gates and map creation/workspace/runtime/UI flows.
- [x] Phase 3: TDD managed workspace and unified room creation.
- [x] Phase 4: TDD unknown context-window regression and visible runtime errors.
- [x] Phase 5: Run focused/full verification and two-axis review.
- [x] Phase 6: Commit, push, create PR, and stop for human merge.

## Decisions

- The context-budget regression is part of UI-001 acceptance because a newly
  created room must be usable and failures must be visible.
- UI-001 does not add adaptive/team scheduling or collaboration settings.
- `primaryAgentId` remains an explicit persisted field.

## Errors Encountered

- The fresh worktree had no installed workspace dependencies. Baseline tests
  could not resolve `hono`/`@socrates/core`, and typecheck/build could not find
  `tsc`. Resolution: install the frozen lockfile before rerunning the baseline.

## Status

**Complete** — verification and independent review are complete; the isolated
change is ready for its PR and human merge.
