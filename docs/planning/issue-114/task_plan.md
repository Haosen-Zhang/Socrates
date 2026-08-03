# Task Plan: OpenCode-inspired modern flat theme

## Goal

Add an optional modern flat appearance theme, adapted from OpenCode's visual
patterns, while preserving Socrates themes, behavior, and React/Tauri stack.

## Phases

- [x] Phase 1: Confirm #116 merge and create isolated #114 worktree.
- [x] Phase 2: Audit Socrates theme seams and OpenCode source/license.
- [x] Phase 3: Define flat-theme tokens and regression tests.
- [x] Phase 4: Implement application shell, dialogs, settings, dock, and composer styling.
- [x] Phase 5: Run responsive visual checks and accessibility review.
- [x] Phase 6: Run lint, tests, typecheck, build, and Tauri smoke.
- [ ] Phase 7: Commit, push, and create independent PR.

## Key Questions

1. Can the theme be implemented through existing token selectors without replacing React components?
2. Which OpenCode patterns are reusable under MIT without importing its SolidJS UI stack?
3. How do we preserve pixel/classic themes without selector leakage?

## Decisions

- Keep the current renderer and component libraries; a visual theme does not justify a framework migration.
- Context defaults and compaction research are tracked separately from #114.

## Errors Encountered

- GitHub API was temporarily unreachable, but local main already contained merge commit #116.
- The Tauri smoke inherited the existing Classic preference, so automated launch
  verified startup but the new Flat theme still needs a manual in-app visual pass.

## Status

**Currently in Phase 7** — preparing the independent commit and PR.
