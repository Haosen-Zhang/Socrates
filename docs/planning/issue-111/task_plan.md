# Task Plan: Model-aware reasoning effort selection

## Goal

Replace the duplicated Agent reasoning controls with one required, polished
select whose options come from real Provider/model capabilities.

## Phases

- [x] Phase 1: Create Issue #111 and isolated worktree from merged main.
- [x] Phase 2: Audit Provider/model capability and Agent create/edit paths.
- [x] Phase 3: Define model-family profiles and migration behavior with tests.
- [x] Phase 4: Implement the single-select Agent form and backend validation.
- [x] Phase 5: Run focused tests, full gates, build and visual smoke.
- [x] Phase 6: Review, debug, commit, push and create PR.

## Test seams

- Core public capability resolver: known model families map to literal options.
- Agent form public draft/validation boundary: exactly one valid effort is saved.
- Sidecar Agent API: unsupported efforts are rejected and legacy data remains readable.

## Decisions

- `auto` is a real required selection, not an empty UI placeholder.
- Unknown custom/open-weight deployments fall back to required `auto/disabled`;
  valid stored capability overrides remain available while the model is unchanged.
- Provider-specific payload mapping is centralized in the existing AI SDK
  gateway rather than introducing a second runtime path.

## Errors Encountered

- The first Tauri smoke launch was blocked by sandboxed `EPERM` on port 1420.
- The escalated retry found the user's existing app on port 1420, so the smoke
  build used an isolated temporary Vite/Tauri config on port 1423.

## Status

**Complete** — implementation, review fixes, full gates and visual smoke passed;
the branch is ready for its independent pull request.
