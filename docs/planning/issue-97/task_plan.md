# Task Plan: UI-002 Collaboration Settings

## Goal

Rebuild room collaboration settings around execution strategy, Agent assignment,
optional pre-execution discussion, plan confirmation, and a read-only tool
permission summary without pretending unsupported runtimes exist.

## Public Test Seams

- Core collaboration configuration validation and normalization.
- SessionStore and Sessions HTTP API persistence.
- Backend runtime capability handshake.
- Desktop collaboration-settings form helpers and room settings UI.

## Phases

- [x] Phase 1: Create Ticket #97, independent branch/worktree, and durable plan.
- [x] Phase 2: Map current collaboration/global defaults/capability call chains.
- [x] Phase 3: TDD the canonical configuration model and migration.
- [x] Phase 4: TDD room/global-default APIs and capability gating.
- [x] Phase 5: TDD and implement the collaboration settings UI.
- [x] Phase 6: Run full verification and two-axis review.
- [ ] Phase 7: Commit, push, create PR, and stop for human merge.

## Decisions

- UI-002 preserves existing Runtime behavior; adaptive/team remain disabled
  unless the backend handshake explicitly advertises them.
- Plan confirmation never grants tool permission.
- Existing room settings are migrated conservatively.

## Errors Encountered

- GitHub API read-only query initially failed in the sandbox. The local main
  merge commit proved PR #96 was merged; Ticket creation succeeded with the
  approved network boundary.

## Status

**Currently in Phase 7** — all gates pass; preparing the isolated commit and PR
for human review.
