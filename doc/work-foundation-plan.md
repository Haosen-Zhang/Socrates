# Work interaction foundation: M00–M01

Starting point: Socrates `b71a826` (current main, including cost PR #143), an isolated managed worktree on `codex/multica-ux-m00-m01`. The supplied pack is read from the original checkout and remains unchanged. No push or release is authorized for this run.

## Decisions

Build on existing RoomCommandService, Native/TeamRunner, EventStore, cost/quote/budget services and Zustand state. Extract reusable UI boundaries rather than moving domain authority into React. Existing PanelResizeHandle, RoomTimeline, AgentAvatar and WorkspaceDock remain useful. Evaluate MIT Base UI for accessible dialogs/pickers; evaluate cmdk and react-resizable-panels against overlap and dependency cost. Multica is a behavior reference only, subject to a source/license audit at both the provided SHA and current main.

Work navigation will expose Rooms, existing Tasks and an honest Squad availability state. M02/M03 persistence and assignment are future dependencies: do not invent Squad records, owners or verified states. Existing task results may be inspected through production services; selecting one must preserve the current room draft and scroll. Narrow screens use a focus-managed detail drawer. Chat remains a lightweight room view.

## Execution gates

- [x] M00: source/license audit, call-chain review, entity/state authority and migration design, existing cost integration seams.
- [x] M00: independently licensed UI component built/rendered and keyboard-tested in a real Socrates business flow.
- [x] M01: ObjectPage/DetailPanel/ActorPicker/StatusBadge/ActivityTimeline/EmptyState/ConfirmationDialog used in business pages; shared errors/loading/tooltip/notification conventions.
- [x] M01: extracted navigation/actions and reusable room header/detail boundaries; Work contexts with no duplicated authority.
- [x] M01: room draft/scroll isolation, search/keyboard/focus/IME, long history, narrow layout and streaming subscription checks.
- [x] Final: 1016/0 tests, typecheck/build/lint, 65 Chrome checks and source/license review; evidence in implementation-progress.md.

## Validation rules

Use disposable SQLite/workspaces and controlled model responses, never the user's live database or paid model. No need for a migration is assumed: M00 must justify the future schema; M01 should use existing authoritative APIs. Keep original source checkout, historical data and supplied prompts intact. Test behavior at real store/service boundaries and browser flows; do not count installed-but-unused dependencies as complete.

## Errors and limits

- GitHub rendered snapshot README fetch missed cache; full temporary source clone is being used instead.
- Baseline and delivery gates passed. A restricted child-sidecar listen failure passed with local-server permission; no application workaround was added. Unsupported formatter/measurement arguments were corrected or abandoned without changing project formatting settings. Browser harness label/timing/duplicate-Store failures were distinguished from actual defects, then corrected flows passed. Native Tauri/live provider validation remains outside the evidence.
