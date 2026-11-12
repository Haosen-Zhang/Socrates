# M07 integration and delivery acceptance

Date: 2026-11-12. Starting source: `53eb9cfa3a9e27703c135eb82c26f30aa6940513`, branch `codex/multica-ux-m06-m07`. This report covers the M07 changes following approved M06. The delivering commit records the exact final source; no release or installer is published. Database schema remains **040** (M06 added039/040); M07 adds no migration and changes no previous checksum.

## What changed

The WorkItem list used to call the full detail projection for every row. With120 completed tasks and40 long messages per task, one response contained12.1MB of historical messages. The task list, room banner, Squad counts and Inbox repeatedly paid this cost even though they only needed ownership and current state.

`WorkItemService.summary()` now uses the same live command/review/verification projection as detail, but omits message/package/review/artifact histories. `list()` returns the exported `WorkItemSummary` type. `get()` remains the complete detail contract. Both UI list consumers, Squad projections and Inbox use the summary. Run metadata, frozen ownership, current status, unknown cost and evidence invalidation remain authoritative; command state is read once per Run instead of twice. The selected detail still comes from its separate detail endpoint and survives polling.

The public local list endpoint `/work-items?workspaceId=…` now returns summaries; use `/work-items/:id` for histories. All repository callers were checked. No execution, billing, approval, dispatch or persistence authority moved into the UI. No new dependency, virtualizer or cache was added. The2-second polling interval remains: final browser measurement records its actual requests and renders, rather than hiding them behind an invented event cache.

## Final-review corrections

Archiving a verified execution room, archiving its workspace, or losing the workspace directory previously threw during WorkItem and global Inbox reads. The shared verification read now recognizes only room/workspace unavailability and returns retained plan/run history with an invalidated status, `gatePassed=false` and no accepted-unverified exemption. Lists, details, Squad projections and unrelated Inbox entries remain readable. WorkItem acceptance is rejected, and verify/accept/approval replay guards still require an available scope. Original verification rows remain unchanged; unexpected service errors and revoked-target errors still propagate. Real-service tests exercise all three unavailable states through HTTP projections and Inbox, compare retained histories, reject acceptance/replay, and check zero extra model calls.

A successful new assignment preview now clears the previous room's selected verification plan. Same-room requotes keep their plan. Fresh Chrome checks approve/bind a plan, replace the preview after budget and budget-mode changes, directly request another preview, bind a new plan and explicitly start exactly one controlled Native execution. Preview/configure/approve/requote steps make zero model calls.

The keyboard check now asserts that Tab from the Chat composer focuses the specifically named Send button, enabled and visibly inside the viewport; [focus screenshot](assets/multica-m07/keyboard-focus.png). It does not establish native accessibility or screen-reader behavior. The missing-notice count is corrected from9 to11, including `@esbuild/darwin-arm64@0.28.1` and `@rollup/rollup-darwin-arm64@4.62.2`; generated inventory and notices were not changed.

## Current verification

Final-review fixes were validated on the final source hashes in `validation.json`. The four unaffected browser suites below remain the pre-fix M07 baseline at `ef4e8f0`; they were not rerun after these fixes. Fresh browser coverage is M06 (18 checks) plus M07 scale/focus (15 checks), not a new run of all100 baseline checks.

| Gate | Current result |
|---|---|
| `bun test` with host access for sockets/macOS tools | **1329 pass,0 fail,24300 assertions,228 files,48.41s** |
| `bun run typecheck` | Pass |
| `bun run lint` | Pass,588 files |
| `bun run --cwd apps/desktop build` | Pass,3.12s; existing mixed-import/large-chunk warnings retained |
| Final focused regressions |25 pass,0 fail,268 assertions,4 files; archive/unavailable evidence, unrelated rows/Inbox, acceptance, stale evidence, revoked-target contract |
| Projection + migration baseline |4 pass,0 fail,50 assertions before final fixes; migration suite also passed in the fresh full gate |
| M02–M03 Chrome baseline (not rerun) |23/23; pre-fix UI and real service fixture |
| M04–M05 Chrome baseline (not rerun) |32/32; lifecycle, instructions, queue, Inbox, history, stop/restart |
| Fresh M06 Chrome suite |18/18; approve/bind → budget/mode/direct replacement → fresh plan/start, zero unexpected model calls, plus prior cost/evidence/Squad/Arena checks |
| P08 stress Chrome baseline (not rerun) |10/10; injected event-connection reset, no duplicate command, two currencies, real approved command output and log pagination |
| Fresh M07 scale/interaction Chrome suite | 15/15; [current checks](assets/multica-m07/scale-checks.json) |
| Startup/upgrade Chrome baseline (not rerun) | 9/9; [current checks](assets/multica-m07/compatibility-checks.json) |

Browser suites use installed Chrome, real React/Zustand, production HTTP routes, RoomCommandService, TeamRunner, Native runtime, event stores and temporary SQLite/workspaces. Only model responses are controlled. The fresh/upgrade suite starts the actual `apps/sidecar/src/index.ts` with disposable `SOCRATES_DATA_DIR` directories and no configured providers. Browser Tauri invocation is a handshake/window shim; this is not an installed Tauri test. Every browser suite records zero renderer errors and zero external browser requests. Fixture model transports reject non-fixture URLs. No paid model calls or private uploads were made.

## Scale evidence and limits

Dataset:36 Agents,12 Squads,120 independently launched WorkItems,40 extra long historical messages per Run (4800 synthetic history messages plus actual command messages). The list benchmark performs5 serial read+JSON serializations; the baseline and optimized source use the same fixture shape.

| Measurement | Before | After |
|---|---:|---:|
| List JSON bytes |12,096,381|444,021|
| Median list read + serialization |108.55ms|19.73ms|
| History payload reduction |—|96.3%|

The final browser recorded first usable task list in 1533ms, filtering in 14.25ms, 2 idle list polls and 2 task-panel renders during4.3s. The long stream was observed for 109.94s and the renderer settled without reload. An early optimized isolated sample was19.67ms. The final browser fixture sample and browser timings are in [metrics](assets/multica-m07/scale-checks.json); timings vary with other test processes and are local observations, not hardware-independent thresholds. The task list renders120 rows; the final filter time is recorded above. A new virtualizer was not justified at this measured scale. Larger task histories still require pagination work; verification continues to check current evidence, and Run metadata still scales with retained attempts.

A controlled Native response emits1200 chunks with50ms minimum spacing. The observed run lasts over a minute (the final measured duration is recorded), passes through the actual SSE/store path, survives switching to Chat and back, and leaves only one durable command. The renderer must settle its running controls without reload. A5-second sample observes room timeline renders while the guarded `RoomSidebar` has no renders. Counts use fresh React development Fiber start times and performed-work flags; stale retained flags and similarly named icons are excluded. This is a narrow subscription-boundary observation, not a claim that every component avoids renders. Settings are not profiled while closed.

The default development build, local IPC transport, mutable-height message content, current SQLite workload and this computer bound these measurements. No multi-hour soak, memory-leak proof or production-WKWebView benchmark is claimed.

## S01–S20 evidence map

Each row points to final-source service tests, fresh M06/M07 browser runs, or the explicitly retained pre-fix browser baseline above. References to M02/M04/P08/startup browser checks below mean that baseline, not post-fix reruns. “Pass” means the stated controlled boundary, not real-provider model quality.

| Scenario | Observed result and current evidence |
|---|---|
| S01 Single Agent | Direct Work launch needs no Squad; single-member Chat and explicit team semantics covered by `room-command-service`, `work-item-launch`, `squads`, Native/room route tests; scale fixture uses real direct Runs. Chat has no workspace tools. |
| S02 Create Squad | Current M02 browser creates/edits/reloads Leader and members; `squads.test.ts` checks persistence/reopen and Leader membership. |
| S03 Agent reuse | `squads.test.ts` freezes independent room revisions and responsibilities across multiple providers; current M02 browser checks binding snapshots and owner history. |
| S04 Assign only | Current M02 browser and `work-item-launch.test.ts` prove owner update/preview leave call counts unchanged. |
| S05 Squad dispatch | Current M02 browser observes one Leader plan before package approval; `work-item-launch.test.ts` checks frozen admission and deduplication. |
| S06 Delegate | `work-interactions.test.ts` runs real TeamRunner completion/delegation, distinct worker model requests, actual package attempts and bounded Leader evaluation; Native tool execution remains authoritative. |
| S07 Temporary mention | Current M04 browser and real `work-interactions.test.ts` target one structured member/Squad; permanent owner remains unchanged; ordinary text mentions do not dispatch. |
| S08 Note | Current M04 browser proves the durable note path creates no command/model call; idempotent persisted note/review tests run in the full suite. |
| S09 During execution | Current M04 browser and restartable interaction tests show queued instruction, next-round settlement and explicit stop/restart; unsupported immediate steering is not advertised. |
| S10 Human review | Current M02/M06 browser distinguishes Run completion, independent evidence and human acceptance. `multica-m06.test.ts` checks root/child evidence revision and successive unverified acknowledgments cannot revive an old review. |
| S11 Workspace contention | Current `workspace/leases.test.ts` and `runtime/execution-runner.test.ts` acquire real SQLite leases, queue direct execution behind package work and cancel without taking a second lease; `agent-lifecycle.test.ts` checks the visible waiting reason. This is service/projection coverage, not a second concurrent-writer browser recording. |
| S12 Pause/reconnect | Current M04 browser preserves pending approvals/Inbox on reload; P08 stress injects a connection reset and observes one durable command. `team-runner.test.ts` checks paused resume without replaying completed workers. |
| S13 Retry | Current TeamRunner/ExecutionRunner tests reserve one retry, retain old attempts and fail closed on unsafe/unknown effects; current Agent history browser opens persisted Run/Attempt timelines. |
| S14 Archive Squad | Current M02 browser checks archive impact and retained historical owner; `work-item-launch` blocks archived Squad launch and retains existing execution references. |
| S15 Unavailable member | `agent-lifecycle`/`work-item-launch`/`squads` tests reject disabled-provider or missing-capability admission; current M04 browser exposes availability and resolves blocked queue without replay. Upgraded missing-provider history stays readable. |
| S16 Unknown cost | Current M06 browser shows unknown consumed cost without fictitious zero; P08 stress retains USD/CNY separately and a nonzero tiny amount; cost ledger/budget service tests pass. |
| S17 Upgrade | Current production sidecar opens a schema022 fixture, preserves room ID, member snapshot and messages; browser archives/unarchives/reloads it and changes between two historical Work projects. Current `p08-compatibility.test.ts` additionally snapshots approval/package/tool/event/cost history, validates automatic backup, reopens, restores the backup with the old migration set, and rejects newer schemas before writes. |
| S18 Duplicate triggers | Concurrent duplicate commands, frozen launch request conflicts, duplicate messages and bounded Leader self-wake protections run through current services; M02/M04 browsers check no repeated model dispatch. |
| S19 Room isolation | Current scale browser retains a Chinese Chat draft while Work streams; current P08 stress verifies recovered Work events stay out of Chat. Current attachment/room lifecycle tests cover upload target/history-generation isolation. Two-project upgrade browser checks no other project's history appears. |
| S20 License | Installed package inventory, upstream notices, source/asset comparison and reuse decisions below. Audit completed with explicit distribution gaps; this is not an unconditional legal/distribution approval. |

## Upgrade, backup and rollback

1. Quit Socrates and its sidecar. Preserve the entire application data directory (default macOS path: `~/Library/Application Support/dev.haosen.socrates`, or `SOCRATES_DATA_DIR`) and project workspaces. Do not copy only an actively changing database. macOS provider keys stay in Keychain; no key export is performed.
2. `openDb` checks applied migration versions/checksums before migration. For an existing database with pending migrations, it creates a consistent `socrates.db.backup-<timestamp>` before applying additive migrations. M07 keeps040 and does not force data recreation.
3. Verify old room IDs/messages/member snapshots, package/approval/event histories and pending/unknown states after upgrade. Existing verified WorkItem acceptances without the full039/040 evidence revision conservatively reopen for fresh human acceptance. Old review records remain; upgrade does not silently mark them Done.
4. On migration/open failure, stop the application. Preserve the failed/current database, WAL/SHM and backup alongside the original config/history/workspaces. Investigate the reported schema/checksum error; never delete `schema_migrations` or reset the database to make startup pass.
5. To roll back, use a **separate restored copy** of the pre-upgrade backup and matching older application code. Keep current files intact until the copy passes integrity/history checks. Do not ask an older binary to open the upgraded schema: current compatibility checks explicitly reject unknown migrations.
6. A database restore does not undo workspace writes or restore Keychain entries. Preserve/recover those separately. Pending unsafe or unknown-outcome tools require review; a database rollback is not authorization to repeat them. Do not run old and new sidecars against the same database simultaneously.

The current migration test actually copies the automatic schema022 backup, runs the old migration set as a no-op, compares all captured legacy table rows (including EventStore events), and checks integrity. No user database was opened or restored.

## Reuse and license audit

- `reuse_existing`: WorkItem/command/verification projection, RoomCommandService, TeamRunner, Native runtime, SQLite migrations, EventStore, lease manager, broker ledger, Zustand selectors, foundation DetailPanel/ActorPicker, existing browser fixtures and P08 stress suite. New code is the narrow summary projection, benchmark/compatibility harnesses and tests; no second scheduler or reducer.
- `reuse_existing`: independent installed React/React DOM19.2.7, Zustand5.0.14, Base UI1.9.0, TanStack virtual3.14.9 and existing SDK/runtime dependencies. Exact installed versions/licenses/notices and installed bytes are authoritative in [runtime-license-inventory.json](../third-party/runtime-license-inventory.json); a dependency name does not establish a license. No library was added or upgraded.
- `reimplement_product_specific`: task summary projection and final acceptance automation use Socrates contracts. M00–M06's independent Squad/workflow implementation is retained.
- `defer`: Multica source, UI, icons, brands and assets. The local sparse reference LICENSE was read in full; its Part I conditions are not replaced by the Apache text in Part II. No applicable commercial/branding permission is assumed. [Source audit](assets/multica-m07/license-source-audit.json) records the local LICENSE hash and zero identical whole files over100 bytes between6 sparse reference files and672 tracked source/script files. This local snapshot has no `.git`; current upstream HEAD is not claimed. Whole-file comparison is supporting evidence, not proof against arbitrary partial copying; changed files/imports/assets were also reviewed.

`scripts/multica-license-audit.mjs` resolves the installed production dependency graph, including installed peers and platform optionals, checks package identity, measures size, hashes packaged LICENSE/NOTICE/README license sections, and emits [RUNTIME-NOTICES.txt](../third-party/RUNTIME-NOTICES.txt). The inventory contains396 installed package versions and32 direct dependency references. Uninstalled platform-specific optional packages are listed separately.

**Distribution gaps found:**11 installed package versions lack an available license/notice section in their installed package; `buffers@0.1.1` also has no declared license metadata. The exact names/versions are in `missingNotices`. Declared metadata is preserved without manufacturing a copyright notice or copying a guessed upstream file. Socrates still has no root distribution LICENSE. Rust crates, signed installers and binary redistribution notices are outside this source-preview audit. Resolve these gaps before a distributable release; this stage neither publishes one nor grants rights it cannot establish.

## Reproduction and evidence handling

Run the root gates above. Start the existing desktop Vite server on a free owned port (the recorded run used45379). Each browser harness accepts `SOCRATES_PLAYWRIGHT_MODULE`; the installed run used `/Users/haosen/.npm/_npx/31e32ef8478fbf80/node_modules/playwright/index.mjs`. Existing suites now accept `SOCRATES_BROWSER_OUTPUT` so reruns do not overwrite prior-stage artifacts.

```sh
bun run --cwd apps/desktop dev --host 127.0.0.1 --port 45379 --strictPort
bun scripts/multica-m07-browser-fixture.ts
SOCRATES_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node scripts/multica-m07-browser.mjs
bun scripts/multica-m07-compatibility-fixture.ts
SOCRATES_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node scripts/multica-m07-compatibility-browser.mjs
node scripts/multica-license-audit.mjs
```

The baseline suites use paired `multica-m02-m03`, `multica-m04-m05`, `multica-m06` and `p08-stress` fixture/browser scripts; set `SOCRATES_MULTICA_UI_URL=http://127.0.0.1:45379/` and distinct output paths. The P08 fixture now delays controlled Native output so event-connection reset cannot be bypassed by a response that finishes before observation begins.

Screenshots are actual UI with explicitly synthetic data and controlled model replies. They are not real user projects, claimed model-quality results or evidence of production task success. Read [checks and screenshot hashes](assets/multica-m07/sha256.json) alongside this report. Earlier untracked `output/playwright` directories and baseline screenshot assets are preserved. Fresh final-review screenshots use the `final-` prefix plus `keyboard-focus.png`; existing README screenshots remain byte-identical. Current check records and performance metrics were refreshed only for M06 and M07 scale/focus.

Not exercised: paid providers, OS input-method candidate windows, VoiceOver/screen-reader announcements, native window/menu integration, signed/notarized installation, clean-machine packaging, Windows/Linux or multi-hour loads. Browser composition events, accessible names, narrow layouts and focus movement are verified only at their stated boundary.
