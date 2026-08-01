# Task Plan: Window Chrome and True Sidebar Hiding

## Goal

Make sidebar collapse remove the rail completely and provide one macOS-aware
room toolbar that remains usable in normal and fullscreen windows.

## Public Test Seams

- Pure window-chrome view model for sidebar visibility and fullscreen layout.
- React toolbar rendering and action callbacks.
- Existing desktop and repository verification gates.

## Phases

- [x] Phase 1: Sync local main and dependencies after PR #102.
- [x] Phase 2: Create Issue #103 worktree from latest origin/main.
- [x] Phase 3: Inspect Tauri window capabilities and current room headers.
- [x] Phase 4: Add failing behavior/component tests.
- [x] Phase 5: Implement window state adapter, toolbar, and true sidebar hide.
- [x] Phase 6: Run native smoke, full gates, and two-axis review.
- [ ] Phase 7: Commit, push, create PR, and stop for human merge.

## Decisions

- Preserve the existing pixel-art design system; the toolbar becomes a compact
  pixel-native desktop chrome rather than a new visual theme.
- Do not render a console button until a real console panel/action exists.
- Fullscreen behavior follows the native Tauri window state, not viewport size.

## Errors Encountered

- The debug app launched, but automated visual inspection could not read the
  window because macOS was locked. Native compilation/config validation still
  passed; the exact visual interactions are listed for manual PR verification.

## Status

**Currently in Phase 7** — verified implementation is ready for commit and PR.
