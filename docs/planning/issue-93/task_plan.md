# Task Plan: Issue #93 Reveal in Finder

## Goal

Add a native Finder reveal action to workspace and workspace-backed conversation menus without inventing paths for legacy Chat rooms.

## Public Test Seam

`resolveSidebarRevealPath` maps a sidebar entity identity plus persisted sessions/workspaces to either one canonical absolute path or `null`.

## Phases

- [x] Phase 1: Confirm latest main, Ticket, branch, worktree, and current data model.
- [x] Phase 2: Add a failing resolver regression test.
- [x] Phase 3: Implement resolver, Finder action, menu item, and translations.
- [x] Phase 4: Run targeted/full verification and review.
- [x] Phase 5: Commit, push, create PR, and stop for human merge.

## Decisions

- Use `@tauri-apps/plugin-opener` `revealItemInDir`.
- A session reveals its bound workspace root because no separate conversation directory exists before UI-001.
- Legacy rooms without `workspaceId` do not display the action.

## Errors Encountered

- GitHub access initially failed inside the network sandbox; the approved external retry succeeded.
- The fresh worktree had no `node_modules`, so the first typecheck could not find `tsc`; `bun install --frozen-lockfile` restored the frozen dependencies.

## Status

**Complete** — PR #94 is ready for human review and merge.
