# Task Plan: Unified Room Sidebar

## Goal

Remove the Chat / Co-work navigation split while preserving every existing room
and workspace relationship.

## Public Test Seams

- Pure sidebar list projection and unified search helpers.
- Existing desktop typecheck, lint, build, and repository test gates.

## Phases

- [x] Phase 1: Create Issue #101 and isolated branch/worktree from merged UI-003.
- [x] Phase 2: Map the segmented navigation and compatibility constraints.
- [x] Phase 3: Add failing unified-navigation regression tests.
- [x] Phase 4: Implement the smallest single-sidebar projection.
- [x] Phase 5: Run focused/full verification and review.
- [x] Phase 6: Commit, push, open PR, and stop for human merge.

## Decisions

- Existing workspace-less legacy rooms remain visible as top-level rooms.
- Rooms with a stale/missing workspace reference also remain visible at the top
  level so persisted history can always be reached.
- Workspace-bound rooms remain grouped under their persisted workspace.
- No persistence or runtime migration is part of this ticket.

## Errors Encountered

- Fresh worktree had no `node_modules`, so the first typecheck could not find
  `tsc`. Install with the committed lockfile before rerunning repository gates.
- Standards review found that stale workspace references could orphan rooms;
  added a top-level fallback and regression test before delivery.

## Status

**Complete** — the unified navigation is verified and ready for human PR review.
