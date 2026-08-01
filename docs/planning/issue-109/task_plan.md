# Task Plan: Responsive workspace shell and overview dock

## Goal

Make the room shell usable at narrow widths, consolidate room information in
the right dock, and use recognisable modern icons in the default theme while
preserving the explicit pixel theme.

## Phases

- [x] Phase 1: Confirm merged baseline, create Issue #109 and isolated worktree.
- [x] Phase 2: Audit current shell, dock, usage, members, themes and references.
- [x] Phase 3: TDD responsive toolbar and overview information architecture.
- [x] Phase 4: Integrate a maintained modern icon adapter for the default theme.
- [x] Phase 5: Run focused tests, full gates, build and Tauri visual smoke.
- [x] Phase 6a: Two-axis review, debug and final verification gates.
- [x] Phase 6b: Prepare the verified commit and PR handoff.

## Key Questions

1. Which current components already own usage, members, files and diffs?
2. Can the existing icon dependency support theme-aware modern/pixel rendering?
3. What is the smallest responsive shell change that prevents narrow-width
   overlap without adding duplicated state?

## Decisions Made

- Keep the current Socrates visual system and component ownership.
- Treat the right dock as one state machine with Overview, Files and Changes.
- Keep collaboration configuration as the only room action in the top bar.
- Preserve Pixel 1998 as an explicit theme rather than forcing pixel icons into
  the default theme.

## Errors Encountered

- `bun add` initially could not write its sandbox temp directory; rerunning the
  same bounded package command with approval succeeded.
- Computer Use did not register the unsigned Tauri dev binary as an app. The
  screenshot helper found the `desktop` window by window id instead.

## Status

**Ready for handoff** — implementation, two-axis review fixes and final
verification are complete.
