# Task Plan: Agent context rings and resizable sidebars

## Goal

Complete the room overview and responsive shell with honest per-Agent context
visibility and persisted, accessible left/right sidebar resizing.

## Phases

- [x] Phase 1: Confirm #112 merge, create #113 and isolated worktree.
- [x] Phase 2: Audit Socrates usage/config/layout seams and OpenCode reference.
- [x] Phase 3: Add tests for context math, config migration, and resize behavior.
- [x] Phase 4: Implement context rings and Agent metadata in Room Overview.
- [x] Phase 5: Implement React resize handles, persisted widths, and ellipsis.
- [x] Phase 6: Run focused/full gates, Tauri visual smoke, and two-axis review.
- [ ] Phase 7: Commit, push, and create the independent PR.

## Key questions

1. Which persisted usage field is the honest numerator for current context?
2. How should right-dock width coexist with its mobile overlay breakpoint?
3. Can the OpenCode interaction be adapted without adding a panel framework?

## Decisions

- Adapt the small MIT OpenCode resize-handle pattern to React; do not add a
  runtime dependency or copy SolidJS code verbatim.
- Keep global visual-theme work in #114.
- Unknown context or capacity displays unavailable; never synthesize a percent.

## Errors encountered

- The isolated worktree initially lacked dependencies; `bun install` restored
  the lockfile-defined workspace packages.
- Desktop build found the capability schema can represent an unknown context
  window; the UI now narrows it to a number before calculating a ratio.

## Status

**Currently in Phase 7** — reviewed fixes pass; preparing the independent PR.
