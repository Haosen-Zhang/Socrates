# Issue #101 Delivery Record

## Delivered

- Removed the visible Chat / Co-work segmented control and its local mode state.
- Unified active navigation and search across legacy rooms, Agent sessions, and
  workspaces.
- Kept workspace-bound rooms in project groups and workspace-less/stale-bound
  rooms visible at the top level.
- Standardized active room rows on one working-room icon without modifying
  persisted room kinds or runtime behavior.

## Verification

- Focused sidebar tests: 8 passed, 0 failed.
- Full `bun test`: 473 passed, 2 platform-specific tests skipped, 0 failed.
- `bun run typecheck`: passed.
- `bun run lint`: 237 files checked, 0 errors.
- `bun run --cwd apps/desktop build`: passed with the existing Vite dynamic
  import and chunk-size warnings.

## Scope Boundaries

- No database migration, provider, protocol, or Agent runtime changes.
- Sidebar true-hide and macOS/fullscreen window chrome remain in the dependent
  follow-up ticket.
