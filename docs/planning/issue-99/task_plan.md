# Task Plan: UI-003 Simplified Task Input

## Goal

Make the room task surface read collaboration policy from room settings and
only expose task input, a truthful strategy/status summary, start action, and a
collaboration-settings entry.

## Public Test Seams

- Pure desktop task-surface view-model helper.
- ChatPage task input and collaboration-settings interaction.
- Existing sidecar task-start API regression suite.

## Phases

- [x] Phase 1: Create Issue #99 and isolated branch/worktree from merged UI-002.
- [x] Phase 2: Map current per-task controls and runtime call chain.
- [x] Phase 3: Add failing task-surface behavior tests.
- [x] Phase 4: Implement the smallest UI simplification without runtime changes.
- [x] Phase 5: Run focused and full verification plus review.
- [x] Phase 6: Commit, push, open PR, and stop for human merge.

## Decisions

- Persisted room collaboration settings are authoritative.
- Unsupported strategies remain disabled through the capability handshake.
- This ticket does not change task orchestration semantics.

## Errors Encountered

- The first integration reused the name of the legacy room composer. The build
  caught the local/imported component collision; the new component is imported
  as `RoomTaskComposer` so the legacy chat composer remains unchanged.

## Status

**Complete** — verification is green and the isolated change is ready for human
PR review and merge.
