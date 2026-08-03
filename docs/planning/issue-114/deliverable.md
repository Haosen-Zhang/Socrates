# Issue #114 delivery

## Delivered

- Optional **OpenCode Flat** appearance theme in all three supported languages.
- Modern Lucide vector icons for the flat theme.
- Flat light and dark palettes for the application shell, sidebars, room rows,
  dialogs, settings cards, workspace dock, tool surfaces, and composer.
- Persisted configuration support and regression tests.
- MIT design-reference attribution without bundling OpenCode code.

## Verification

- `bun run lint` — 264 files checked, 0 errors.
- `bun test` — 510 passed, 2 platform-specific tests skipped, 0 failed.
- `bun run typecheck` — passed.
- `bun run --cwd apps/desktop test:visual` — 9 passed and Vite build passed.
- `bun run dev` — Tauri completed a clean Rust compile and launched the desktop
  process successfully.

The Vite build retains the repository's existing large-chunk warnings. The
launch inherited the existing Classic preference, so selecting OpenCode Flat in
Appearance and checking light/dark, narrow width, dialogs, and the workspace dock
remains a manual PR-review step.

## Deferred

Model-specific context defaults and automatic context compaction are deliberately
separate from this visual-only ticket.
