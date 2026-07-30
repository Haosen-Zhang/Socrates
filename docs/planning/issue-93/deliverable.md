# Issue #93 Delivery Record

## Scope completed

- Added `Reveal in Finder` to workspace menus.
- Added the same action to conversations with a persisted workspace binding.
- Kept the action absent for legacy rooms and conversations without a workspace.
- Surface a localized sidebar error for a stale workspace binding.
- Reused Tauri opener's native `revealItemInDir`; no shell command or AppleScript.

## Data and protocol impact

- No database migration.
- No API or SSE protocol change.
- No new dependency or Tauri capability expansion.
- A conversation currently reveals its workspace root because it has no separate
  on-disk conversation directory before UI-001.

## Verification

- `bun test apps/desktop/src/sidebar/revealInFinder.test.ts`: 5 passed.
- `bun test`: 458 passed, 2 skipped, 0 failed.
- `bun run typecheck`: passed.
- `bun run lint`: passed (224 files).
- `bun run --cwd apps/desktop build`: passed.
- Standards review: approved; the initial non-blocking adapter test gap was covered.
- Specification review: approved after stale workspace bindings became actionable errors.

## Manual verification remaining

- In the packaged/Tauri UI, verify a workspace menu opens its canonical folder.
- Verify a workspace-backed conversation opens that same folder.
- Verify legacy Chat items do not offer the action.
