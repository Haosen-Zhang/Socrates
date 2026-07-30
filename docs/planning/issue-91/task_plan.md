# Task Plan: Issue #91 Common Workspace and Document Tools

## Goal

Deliver a reviewable PR that adds bounded, approval-aware workspace and document tool nodes without weakening the existing path or room policy boundaries.

## Public Test Seams

1. `createWorkspaceWriteBuiltins` definitions and their observable filesystem outputs.
2. `NativeAgentRuntime` approval events and exact allow/deny effects.
3. `SessionStore` and migration output for default room approval policy.
4. `SingleAgentSession` compact policy header/selector with the redundant runtime banner absent.

## Phases

- [x] Phase 1: Confirm issue, branch, worktree, scope, and source/licence options.
- [x] Phase 2: Record baseline and add failing UI/policy regression tests.
- [x] Phase 3: Implement bounded directory, copy, and move/rename nodes.
- [x] Phase 4: Implement bounded ZIP creation.
- [x] Phase 5: Implement structured DOCX, XLSX, and CSV creation.
- [x] Phase 6: Run targeted/full verification and independent code review.
- [x] Phase 7: Commit, push, create PR, and stop for human merge.

## Decisions Made

- Local file/document operations are built-in tools, not MCP.
- Reuse maintained MIT TypeScript libraries for ZIP and Office formats instead of hand-writing format internals.
- No overwrite, extraction, recursive deletion, arbitrary Office editing, or shell fallback in this ticket.
- Existing/new room default remains `ask`: tools are available but side effects are not silently approved.
- Native mutation tools remain fail-closed outside supported platforms.

## Errors Encountered

- GitHub had no issue #91 yet; created it from the recovered scope.
- Initial baseline commands failed because the new worktree had no `node_modules` (`tsc`, Biome, and Zustand unresolved); run `bun install` before recording the real baseline.
- The first sidecar smoke used the checkout's default data directory and hit a read-only existing database; the isolated-data retry then hit sandbox port binding. Running the isolated-data smoke outside the network sandbox succeeded.

## Status

**Complete** — PR #92 is ready for human review and merge.
