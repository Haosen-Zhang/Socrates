# M04–M05 implementation and acceptance

Scope: Agent lifecycle, run timeline, structured routing, bounded handoff and local Inbox. Base `d87b365` (PR #153 merged), branch `codex/multica-ux-m04-m05`, issue #154. Current worktree already contains untracked earlier browser artifacts; they remain untouched.

## Authority and scope

AgentDefinition is configuration, not a process. Availability derives from provider/runtime/credential/tool evidence; workload derives from current runs/packages/queues. A failed historical run never changes provider reachability. WorkItem ownership remains separate from a temporary message target and each frozen execution identity.

The existing EventStore/ExecutionEventStore, RoomCommandService, TeamRunner, Native Runtime, WorkspaceLeaseManager, Approval and cost/verification services remain authoritative. New records may persist probe evidence, user instructions and deduplication; they must not copy tool results or invent a parallel runtime. Agent text and raw `@name` do not schedule work. Native has no reliable acknowledged in-run injection; user options are queue or confirmed stop then restart.

Reuse/license audit: [reuse-decisions.md](reuse-decisions.md), including the actual reference checkout and pinned-path discrepancy. No Multica code/assets or new dependency is incorporated.

## Validation

Implemented and stage-reviewed. After the final integration fixes, **1312 tests and 32 actual Chrome checks pass**; typecheck, desktop build, lint (583 files) and diff-check pass. Final scoped review is approved; submission evidence is recorded below. Tests use temporary SQLite/workspaces and controlled providers; no private content or paid provider calls.

### M04 evidence

Local implementation `995cf81`: pure core projections + migration 037 probe evidence; service-level Native/package/planning/discussion run union; shared roster detail; 30-day cost/statistics; paged grouped timeline, durable event invalidation, canonical recorded write diffs and current verification/Git evidence (clearly separated).

- 81 targeted tests, 0 failures: actual temporary SQLite migration/reopen, expired/stale provider evidence, capability change, unavailable+idle, workspace queue/approval/pause/retries, team attempts, stable event cursors, real Native write/diff and rewind/no-ghost records. Billing retained after rewind.
- Root typecheck and desktop build passed. Existing Vite chunk-size/dynamic-import warnings remain.
- Chrome checks 8/8: roster→detail, completed run leaves idle, durable timeline, no-Git honesty, unavailable provider independent of idle, re-enable remains unknown without probe, narrow drawer within viewport, zero renderer errors/external browser requests. Screenshot visually inspected at 650×600. Evidence currently in `output/playwright/multica-m04-m05` (final subset copied into tracked docs after both stages).

Provider evidence certifies only a recent models-endpoint probe, never inference or all model access. Historical diffs exist only where canonical tool output contains them; missing evidence remains unavailable. Existing retention bounds are disclosed. No native installer/OS IME/real API verification performed.


### M04 review repairs

- Stable cost root preserves old adaptive child timelines after the workflow's current child changes. Existing materialized recorder rows are repaired in place, preserving record/cursor identity.
- Runtime, command and task journals retain their own sequence; current status/metadata snapshots are labeled separately rather than presented as execution chronology. Rewind removes derived records without deleting billing facts.
- Two Important findings were fixed in `8395c6e` and scoped re-review approved; 24 focused tests/160 assertions passed after the repairs.

### M05 implementation

Migration 038 appends durable `work_interactions`, `leader_evaluations`, `leader_report_receipts`, `inbox_delivery` and `inbox_notifications`. Historical package reports are consumed during migration so an upgrade does not replay old model work. Queue recovery reuses stable command identity; ambiguous partial dispatch is blocked for review rather than silently retried.

- Structured `@agent` and `@squad` resolve stable IDs against the current/frozen room roster and Squad binding. A single temporary target uses existing direct execution; it never changes persistent Owner. Owner assignment/start remains the separately validated M03 flow. Raw text/Markdown never schedules a call.
- WorkItem instructions and RoomComposer both use the durable service. Notes and human-review requests persist without model calls. Files selected for execution remain selected when saving a text-only note. Lost-response retries retain the original request, quote and budget identity; late acknowledgements clear only captured files in the originating room.
- Server `Will trigger` previews target, rule, actual queued work and admission blockers. Preview, quote and routing schemas accept the same structured Squad ID. The existing ActorPicker, DetailPanel, Notifications, RoomCommandService, Coordinator, TeamRunner, budget, approval and workspace lease services are reused in live paths.
- Ordinary instructions can queue or stop/restart. Restart waits for cancellation and both tool/model-cost settlement; unknown outcomes or unreconciled costs block further dispatch even without a monetary cap. A blocked old instruction does not replay when its underlying condition is resolved; submit a new instruction explicitly.
- Leader evaluation has at most 4 evaluations and 2 delegations per WorkItem, a 1024-token structured-decision output bound and a 24000-character context bound. These internal bounds are not the ordinary task-output cap. One pending evaluation per WorkItem coalesces stable member report identities; Leader summaries do not wake themselves. Evaluations inherit the original budget and can only return no_action, human review, or continue approved work through TeamRunner. They cannot rewrite an approved plan or execute arbitrary model-generated actions.
- Leader `now` requires quiescent Coordinator/TeamRunner, including an approval wait or pause. Leader `queue` waits for owner execution settlement. Leader stop/restart is explicitly unsupported: a cancelled workflow needs a new approved start. Cancellation, current command/task/room and owner handoff are revalidated before a model call and again before delegation.
- Native has no durable in-run instruction receipt, so insertion remains disabled with an explanation. Work composer stays usable while execution/approval is pending. Stored interaction history reattaches existing room observers only for the selected room.
- Local project Inbox aggregates approval/verification/budget/unknown-side-effect/blocked/human-review facts. Notifications are fingerprinted by meaningful state transition; reading a notification is separate from resolving its source. Exact IDs link to WorkItem, Room, Run, Package and Approval context. Explicit review and blocked-instruction resolutions persist without replay; original room controls remain authoritative for permissions/budget/verification.

### M05 stage review and fixes

Three Important findings were repaired and scoped re-review approved in `a2a6494`: Leader delivery semantics, cancellation/replacement authority, and resolving blocked ordinary instructions. Browser extension found the stale Squad mention union in cost/routing HTTP schemas; `40afb6e` fixes both callers and adds standard/Custom quote→interaction-dispatch regressions. Existing and new tests cover queue service restart, conflicting replay, missing provider, frozen owner budget, unknown tool outcomes, unresolved cost, duplicate reports, bounded no_action, stale evaluation and cancelled/changed execution.

## Reproducible commands

Run from repository root with Bun installed:

```sh
bun test
bun run typecheck
bun run --cwd apps/desktop build
bun run lint
git diff --check
```

Browser harness uses the installed Playwright runtime and Chrome against real local UI/sidecar; the Tauri handshake is the only browser adapter. Fixtures create and delete their own SQLite/workspace, refuse non-fixture provider URLs, and expose only synthetic test setup/count endpoints.

```sh
bun run --cwd apps/desktop dev --host 127.0.0.1 --port 45369 --strictPort
bun scripts/multica-m04-m05-browser-fixture.ts
SOCRATES_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node scripts/multica-m04-m05-browser.mjs
```

Required host permissions concern local listening sockets, Chrome and macOS sandbox execution tests; they do not grant paid model use. Metadata is `/private/tmp/socrates-multica-m04-m05.json`. Stop only the fixture PID and Vite process started for this test.

## Remaining stages and limits

M06 execution interaction refinements and M07 full stress/acceptance remain separate work. No optional shortcut menu, Native Runtime rewrite, new dependency, Multica source/assets, paid provider testing, private uploads, native installer/OS IME/screen-reader validation, merge or release. Vite's pre-existing chunk-size/mixed-import warnings remain. Current test evidence and current Git changes are clearly distinct from historical Run evidence. Actual provider models-endpoint connectivity does not prove inference authorization.

## Final validation before whole-branch review

- Full suite: **1305 passed, 0 failed, 24024 assertions, 225 files** (43.37s). `bun run typecheck`, desktop build, lint (581 files) and diff-check passed.
- Actual Chrome: **24/24 passed**, no external browser requests and no renderer errors. Includes both WorkItem and Room composer paths, real Squad quote→dispatch, note zero calls, exact-target admission, persisted queue/reload, approval deep link, bounded Leader no_action, stop/restart history, both human and blocked Inbox resolution/reload/no replay, read-only controls do not send an unsent draft, and narrow scrolling.
- Machine results and synthetic screenshots: [checks.json](assets/multica-m04-m05/checks.json), [Agent](assets/multica-m04-m05/agent-detail.png), [Inbox](assets/multica-m04-m05/inbox.png), [narrow instructions](assets/multica-m04-m05/interactions-narrow.png), [Room instructions](assets/multica-m04-m05/room-instructions.png). [SHA-256 manifest](assets/multica-m04-m05/sha256.json). Screenshots visually inspected.
- Full suite output: `/private/tmp/socrates-m04-m05-tests-final.log`. Temporary browser DOM/logs stay untracked; no real data is included in evidence.

## Final whole-branch review

The broad review found five integration defects missed by isolated stage tests: restrictive interaction foreign keys blocked ordinary room deletion; inline history timelines exceeded the composer viewport; M05 queued instructions were absent from M04 workload; tool approval/unknown-outcome Inbox roots did not match recorder roots; older adaptive planning/review turns lost their frozen root. All are assigned to one combined fix wave with real-service and browser regressions. Final fix results are appended after verification; the earlier 24 checks alone are not acceptance for these boundaries.

## Execution decisions

1. Keep Runtime/RoomCommandService/TeamRunner as the execution authority and add only persisted dispatch/evidence/projection facts. This follows the specification and avoids a second scheduler; a mistaken authority mapping would require migration/dispatch repair.
2. Use the user's standing automatic-PR authorization and AGENTS.md, overriding the prompt pack's default no-push instruction. Push only this feature branch and create/update a PR; never merge or release. If the intended authorization changes, the remote branch/PR can be closed without merging.
3. Because the specified Multica source path is absent at its cited revision, use the separately audited existing checkout with its actual SHA, explicitly documenting the mismatch. No source/assets are copied. If that reference is unsuitable, redo the behavior comparison; the implementation remains Socrates-owned.
4. Continue the minimal residual Leader-state correction despite the workflow skill's final-wave limit: the user's complete-implementation request takes precedence over stopping with a reproduced required-state defect. The tradeoff is additional focused validation/review time; no new feature or runtime authority is introduced.


### Final combined fix wave (`f9b4f56`)

All five broad-review findings were repaired together, with no migration checksum changes or new dependency:

- Explicit ordinary-room deletion removes its interaction/evaluation dependencies and Inbox projections in the existing transaction; billing is retained and the WorkItem execution-history deletion guard remains. Rechecking after asynchronous history staging prevents deleting a newly started queued Run and restores staged history on rejection.
- History timelines now use the installed foundation DetailPanel portal. Composer options scroll locally under a height bound; draft and send remain outside that region. Actual desktop/narrow geometry asserts no application-root scrolling and visible navigation, toolbar, textarea and send after inspecting diagnostics/test evidence.
- Durable instructions and pending Leader evaluations enter the independent workload projection. Pre-Run queue identities link to the real room, with no invented Run/root. Dispatch/recovery deduplicate projections; blocked/resolved rows update workload without changing availability.
- Recorder, Inbox and workload reuse one execution-root resolver. Inbox carries explicit root/task/run/package/approval IDs, including real Native tool approvals and unknown adaptive child outcomes.
- Older planning/review turns use the frozen cost root after the adaptive command advances to another child, preserving materialized record IDs/cursors and revoked-root filtering.

Final full suite: **1312 pass / 0 fail / 24093 assertions / 226 files**, 43.15s (`/private/tmp/socrates-m04-m05-final-fix-tests.log`). Focused wave: **95 pass / 487 assertions / 9 files**, including actual deletion/retained billing, staging race, queue recovery/dispatch/block/resolution, approval→recorder HTTP events and old planner/reviewer links. Typecheck, desktop build, lint583 and diff-check pass.

Final actual Chrome: **32/32 pass**, no renderer errors or external browser requests. Added queue Agent→room, real tool-approval Inbox→execution events, old adaptive planner Agent→timeline, and expanded diagnostic/test-evidence layout at 1440×1000 and 650×600. Controller inspected [narrow composer](assets/multica-m04-m05/room-composer-650.png), [bounded timeline](assets/multica-m04-m05/room-instructions-650.png), and [actual approval events](assets/multica-m04-m05/inbox-tool-approval-events.png). [Older adaptive history](assets/multica-m04-m05/agent-adaptive-history.png), final machine checks and SHA-256 manifest are in the same evidence directory. This supersedes the earlier 24-check capture.

The final scoped re-review accepted four fixes and found one residual workload edge case: an automatic Leader evaluation after its parent completed was hidden by raw-turn deduplication. A narrow follow-up is required before completion; the previously reported 1312/32 results do not cover that state. The work continues to satisfy the requested M04–M05 behavior rather than parking a known defect under a process-round limit.



### Final approval and verified source

The residual state edge is repaired in `7790a43` / `c7e4245`: an exact, task-matched durably running Leader evaluation keeps its actual post-completion turn `running` in recent activity and workload, without duplication. Settled/stale turns still project interrupted. The real TeamRunner completion callback regression covers both states. Final scoped review is **approved; all five broad-review findings are closed**, with no remaining Critical/Important findings.

On source `c7e4245`: **1312 tests pass / 0 fail / 24102 assertions / 226 files** (42.98s), root typecheck, desktop build (2.72s), lint583 and diff-check pass. The final 32-check Chrome capture is from `f9b4f56`; subsequent changes touch only backend lifecycle projection and its real-service regression, with no UI/harness changes. The final full-suite log is `/private/tmp/socrates-m04-m05-verified-tests.log`. [Validation metadata](assets/multica-m04-m05/validation.json) records these exact boundaries.

M04 and M05 are complete. M06/M07, optional shortcut menus and the native/real-provider verification limitations above remain outside this run scope.
