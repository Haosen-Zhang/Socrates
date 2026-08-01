# Task Plan: New-room project flow and integrated macOS chrome

## Goal

Restore the expected temporary/project creation choices and align the macOS
overlay titlebar with the sidebar/content split using existing Socrates modules.

## Phases

- [x] Phase 1: Confirm merged baseline, create Issue #107 and isolated worktree.
- [x] Phase 2: Audit current public seams and relevant reference layout.
- [x] Phase 3: TDD the new-room selection state and folder registration flow.
- [x] Phase 4: TDD and implement the window chrome layout.
- [x] Phase 5: Run focused tests, full gates and production build; attempt UI smoke.
- [x] Phase 6: Review, commit, push, create PR and stop for merge.

## Decisions Made

- A temporary conversation reuses the existing managed-workspace backend; it
  does not expose the managed directory choice as product jargon.
- Project-folder creation can reuse a registered workspace or register a folder
  selected through the existing Tauri dialog plugin.
- Reuse `WindowRoomToolbar`, `windowChrome`, Workspace store methods and the
  existing sidebar. Do not introduce another application shell.
- The supplied source checkout is Claude Code Ink/TUI, not a compatible desktop
  frontend. Use it only for interaction vocabulary; no source is copied.

## Errors Encountered

- Isolated Tauri smoke could not start because the user's main checkout already
  owns Vite port 1420. The existing process was left untouched.

## Status

**Complete** — verified and ready for the independent PR.
