# Task Plan: Workspace Explorer and Git Diff Dock

## Goal

Add two workspace-aware toolbar actions backed by real sidecar data: a bounded
file explorer and a readable Git working-tree diff dock.

## Phases

- [x] Phase 1: Sync main, create Issue #105, branch, and isolated worktree.
- [x] Phase 2: Audit existing Socrates seams and reference implementations.
- [x] Phase 3: Select reusable licensed modules and define public test seams.
- [x] Phase 4: Add failing sidecar and desktop tests.
- [x] Phase 5: Implement the smallest complete backend and UI flow.
- [x] Phase 6: Run focused tests, full gates, and desktop production build.
- [ ] Phase 7: Two-axis review, commit, push, create PR, and stop for merge.

## Key Questions

1. Which existing Socrates workspace/path-policy APIs can supply tree data?
2. Which maintained module best renders a virtualized tree and readable diff?
3. Which reference code is reusable under a compatible license?
4. How should non-Git and large/binary diffs degrade safely?

## Decisions Made

- One shared right dock owns both views; toolbar buttons switch the dock mode.
- The ticket is read-only and must not introduce another tool protocol.
- Reference projects guide interaction and structure; copied code requires a
  compatible license and attribution.
- Use `@tanstack/react-virtual` for Reasonix-style flattened row virtualization,
  `@git-diff-view/react` behind a local renderer seam, and `simple-git` for
  bounded fixed-argument Git acquisition.
- Public test seams are authenticated Hono content routes and the React
  `WorkspaceDock` behavior; dependency internals remain replaceable.

## Errors Encountered

- The previously referenced local Reasonix download no longer exists at
  `/Users/haosen/Downloads/DeepSeek-Reasonix-desktop-v0.53.0`; research used
  commit-pinned upstream source instead.
- `simple-git` rejects `core.hooksPath` configuration unless its unsafe plugin
  is explicitly enabled. Read-only status/diff commands do not execute hooks,
  so the adapter removed that unnecessary option instead of weakening the
  library's safety policy.
- `FileStatusSummary` is not a public named export in `simple-git` 3.36; the
  adapter derives the file type from public `StatusResult["files"]`.
- `simple-git` deliberately rejects unsafe pager/config environment overrides.
  The adapter does not inject any of them; fixed read-only commands disable
  external diff/textconv explicitly.

## Status

**Currently in Phase 7** — reviewed and ready to commit, push, and open the PR.
