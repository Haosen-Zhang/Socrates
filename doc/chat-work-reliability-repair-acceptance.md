# Chat / Work reliability repair acceptance

Date: 2026-11-05. Baseline: `4c1faa536a382b70ec5d43b19907bc10973d1f64` (PR #137 merged, current remote main when work began).
Working branch: `codex/fix-room-lifecycle-consistency`. Tracking: [issue #138](https://github.com/Haosen-Zhang/Socrates/issues/138).

This is new execution evidence for the repair request, not the previous implementation's pass counts. Existing `.reasonix` and unrelated local preview artifacts were preserved.

## Changes and regression evidence

| Requirement | Root cause and repair | Production-path regression |
| --- | --- | --- |
| Attachment import A → B | Awaited imports used the selected room. Capture room/workspace/path once; batch success, failure, progress and cleanup update that room's existing projection. | `roomStoreIsolation.test.ts`: delayed workspace + clipboard returns, batch target/errors, draft preservation. |
| Draft/member/mention/ref ownership | Local legacy composers could reuse text in another room. All writable rooms use RoomComposer, per-room drafts/mentions/attachments/refs, explicit send snapshot; consume only submitted files. | Store tests for send during navigation and newer draft/file preservation; browser switches legacy, new Chat and two Work rooms. |
| Stale history GET | Each GET replaced messages unconditionally. Shared refresh uses per-room request version, live revision and explicit rewind generation. | Delayed initial GET after completed command, overlapping loads, authoritative empty rewind and late SSE/GET. |
| Resume/retry cross-room failures | Catch/finally wrote global visible task state. Task controls and follow-up loads capture the task's session and update its projection. | Deferred failure in A while B remains running and error-free. |
| Legacy/new interaction | Legacy member count selected a separate two-round composer. Migration 022 supplies canonical sessions and history; frontend resolves same ID or existing legacyRoomId mapping. | Real version-1 schema fixture; original messages/authors/order/archive/task references; repeated migrations; existing journal import; no duplicate history. |
| Navigation/archive/height | Startup chose a legacy room before unified lists loaded; archived selection could be implicit. Restore valid per-mode selection, otherwise a live mode-matching room or empty state. Archived rooms show Restore. Height storage, drag/key controls and viewport limits retained with visible reset. | Store mode persistence/rehydration tests and browser checks for abnormal stored height, resize, reset, archive and last Work selection. |
| Shared task context | Manager omitted prior public room conversation. Shared bounded context builder is used by Manager, task discussion, plan/package reviewer and Worker with the task's frozen cursor and original role/author/message boundaries. Current task results remain in task-specific context. | `room-team-context.test.ts`: actual gateway capture with discussion on/off, room exclusion, request once, later messages excluded during replan/resume. |
| Queued legacy pause | Pause interrupted an empty runtime ID without aborting queued lease acquisition. Abort controller first; interrupt only a created runtime; await execution cleanup and lease release. Cancel/shutdown share these guarantees. | `execution-runner.test.ts`: actual lease queue, pending runtime open/close, pause/cancel/shutdown release and no dispatch. |
| Team pause/resume | State/attempt changed before old runner summary settled. Validate ownership/approved packages before transition; transactionally reset attempts; reject overlapping start while keeping recovery possible. Startup failures persist reasons. | `team-runner.test.ts`: gated real HistoryStore append, resume rejection preserves state/attempt, one later runner, retry/unknown outcome rules. |
| Edit-and-approve failure | Transition preceded full validation and approval writes. Validate members, frozen tool capabilities, dependencies, exact version/hash, then save plan/packages/approval/state in one composable transaction. | `multi-agent.test.ts`: invalid/ineligible owner, cycle, stale hash and injected SQLite write failure preserve pending plan; valid edit and idempotent replay work. |
| Rewind/recovery | Commands and earlier continuation attempts survived message removal. Durable rewind projection v2 expands affected turn/run/Team ownership, revokes commands, removes runtime/task projections, expires approvals; old journal intents remain readable. Command tombstones gate list/retry/replay; missing runs return no recovery IDs. Durable lookup overrides supervisor caches. | `room-command-rewind.test.ts`: direct/discussion completion, same request replay, continuation and Team child rewind, injected projection failure + restart; `run-supervisor.test.ts`: cached removed run. |
| Team realtime | New command started Coordinator without a connected durable stream. Coordinator/Worker events now carry task/member/turn/run and durable sequence; RoomCommand SSE replays them; store observers persist across views/reconnect and deduplicate. Terminal closure waits for summary settlement; recoverable review failure remains nonterminal. | Server SSE before model completion, cursor replay/restart/large page draining, reviewer recovery; store Worker text/approval without mounted polling; browser realtime author text/switch/reload. |
| Work defaults | Explicit kind selected hardcoded defaults. New Work rooms snapshot user defaults; absent customization stays single. Invalid member/execution roles normalize. Chat keeps its boundary; settings text says future Work rooms. | `sessions.test.ts` sends actual `kind: "cowork"`, tests custom/default/eligibility/Chat and unchanged existing rooms. |
| Parent usage | Parent queried only its own task ID. Aggregate original stable records for parent and every child attempt without copying rows; retain Agent breakdown and unknown prices. | Actual Native tool execution: Worker 100 input + 25 output = 125; budget retry = 250 for that worker; Manager 15 and other Worker 125 yield room total 390; replay unchanged. Failed Worker attempts also retained. |
| Native tool scope | Scope recognized only old names and loosely matched strings. Match actual structured tool path/argv/cwd fields, normalized relative paths and literal plan commands; compatible legacy aliases remain. | Core in/out scope tests + production ExecutionRunner approval classification and actual Native write-file integration. |

## Compatibility and authority

- Formal migration **022** runs in the existing transactional/checksummed migration framework; `openDb` retains the existing pre-upgrade backup behavior.
- Normally a legacy room keeps its ID. If `sessions.legacy_room_id` already maps it, that stable mapping is retained; existing canonical member settings and native task/approval associations remain intact.
- Original message IDs, order, content, authors/models, archive state and task references are preserved. Deleted Agent templates produce an explicitly unavailable member that the existing member editor can repair.
- `sessions/session_messages` become writable authority. Existing `HistoryStore.bootstrapAll()` exports imported rows into its journal before reconciliation, including already-mapped rooms with a journal. Legacy tables remain immutable audit/task sources; old mutating endpoints return the canonical session mapping instead of forking history.
- Legacy process-only running tasks cannot have a surviving controller across upgrade; they retain their audit records with an explicit interrupted reason. Native tasks and pending approvals are not reset.
- Repeated migration and restart do not duplicate rooms/messages. Rewinding does not reimport audit-source messages. Explicitly deleting a migrated room removes its legacy source too, preventing sidebar resurrection.
- Rewind changes conversation history only; it does not reverse workspace side effects. Unknown tool outcomes still require explicit review before retry.

## Executed validation

- `bun test` on the macOS host: **879 passed, 0 failed, 0 skipped**, 3303 assertions across 156 files (18.73 s). All four platform-specific command/filesystem isolation tests executed successfully. An earlier restricted run skipped these four; the final host run supersedes that limitation.
- `bun run typecheck`: passed.
- `bun run --cwd apps/desktop build`: passed (2.12 s); existing bundle-size and static/dynamic-import warnings remain.
- `git diff --check`: passed. Targeted Biome lint of modified/new TypeScript source and tests: passed.
- Chrome UI: **28 checks passed, zero page exceptions** across `output/playwright/reliability/checks.json` (21) and `lifecycle-checks.json` (7). Screenshots were visually inspected.
- UI coverage includes startup with archived old + live new rooms, historical author/Composer/default member, structured mention and mode drafts, delayed actual attachment upload across rooms, file-reference ownership, abnormal saved height/window shrink/reset, Team SSE text before completion and switch-away/back, final-message dedup, restoring last Work selection after reload, direct/discussion rewind + reload with no commands, and Team pause + package retry ending in the exact required attempt counts.
- Production restart tests reconstruct service/HistoryStore/runtime projections, including injected journal-projection failure. Browser reload tests validate renderer recovery; they do not claim a native application relaunch.

During validation, the preview fixture was corrected to expose `/mcp/servers`, use the production file-context resolver and use actual NativeAgentRuntime/HistoryStore with a controlled external model stream. UI-script failures from missing waits, a confirmation click, selector ambiguity, development hot updates and simultaneous host-test resource contention were corrected; the final stable browser runs passed. No production assertion was relaxed to obtain green results.

## Verification boundary

All experiments used in-memory/test databases and temporary workspaces/history. Production stores, state machines, HistoryStore, RuntimeManager, NativeAgentRuntime, ToolExecutor, approvals and leases were exercised; external model/network behavior was controlled. No user provider credentials or existing room data were read or altered.

Browser verification uses actual React/Zustand UI and a temporary sidecar, with controlled external model streams. Native Tauri window packaging and a live paid Provider conversation are not claimed by these tests. Existing Vite large-chunk and mixed static/dynamic-import warnings are informational and were not hidden.

## Reproduce the UI fixture

1. Run `SOCRATES_UI_RELIABILITY=1 bun apps/sidecar/scripts/chat-work-preview.ts` from the repository root (port 45327).
2. Run `bun run --cwd apps/desktop dev --host 127.0.0.1 --port 45328`.
3. With Chrome and Playwright installed, run `node output/playwright/reliability/check.mjs`. If Playwright is not resolvable locally, set `SOCRATES_PLAYWRIGHT_MODULE` to its installed `index.mjs` path.
4. Run `node output/playwright/reliability/lifecycle.mjs` with the same Playwright module setting to verify pause/continue and rewind/reload.
5. Results/screenshots are written under `output/playwright/reliability/`. Restart the fixture before repeating a full run to use fresh isolated data.
