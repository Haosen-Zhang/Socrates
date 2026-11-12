# M06 integration: cost, verification, memory and recorded Squad work

Baseline: `ca524f8`, branch `codex/multica-ux-m06-m07`. M06 preserves the P00–P08 services and the M00–M05 execution model. M07 scale/stress acceptance remains a separate stage.

## Source and reuse audit

The prompt pack's Alpha.1 `routing:false` description is historical: current `packages/core/src/room-kind.ts` declares supported routing; `route-policy.ts`, `adaptive-workflow.ts`, the broker and budget ledger implement it. UI options are gated by the actual `/agent/capabilities` collaboration declaration. No second scheduler, ledger, memory store or SSE transport was introduced.

| Capability | Actual implementation before M06 | M06 integration and evidence |
|---|---|---|
| P00–P01 invocation identity, usage, prices and quotes | `model-invocation-broker.ts`, `cost-ledger.ts`, `pricing-store.ts`, `task-quotes.ts`; physical invocation IDs and immutable price snapshots | `/cost/scopes` reads the same ledger for Project, WorkItem, Squad, Agent, Run and Package. UI shows unknown usage/prices and separates actual totals from estimates. Quotes remain the original frozen `cost_quotes` records. |
| P02 Task Budget | `BudgetLedger.reserve` at the broker's model-call entrance; reconciliation, increases and resumptions already present | WorkItem/Run cost panels show budget absence explicitly and display `budget_stopped` with the backend reason. Nonfeasible routing preflight cannot advertise Start. No budget handler in a UI button. |
| P03 Verified Work | `VerificationService` owns plans, independent checks, protected/artifact fingerprints, approvals and reruns | Reuse `VerificationControls` before launch and `VerificationPanel` for each Run/Package. Requoting binds an approved plan in the same frozen execution room. Human acceptance references its verification run. Changed artifacts reopen review; reverified evidence needs fresh human acceptance. |
| P04 Economy / Balanced / Quality / Custom | deterministic supported route selection and durable adaptive execution; membership, capability, provider, risk and budget checks already enforced | Versioned Squad preset maps to the existing collaboration input. Legacy/manual Squad behavior remains Leader-first. Automatic routes may use direct execution; the preview names selected route/members. Custom retains the configured Leader and member pool. Discussion stays off. |
| P05 Flight Recorder | existing root resolution, durable record identities, model/attempt/tool/approval/evidence/cost records | Frozen command attribution adds Squad revision, Leader, WorkItem and WorkItemRun IDs; `squad.dispatched` joins the same execution root. Who/why/when and model/evidence/cost can be followed without reconstructing from current owner or room binding. |
| P06 Portable Project Memory | `ProjectMemoryService.freeze/context`; every broker request checks live authorization, confirmed status, version and provider scope | Reused unchanged. Real Leader and WorkPackage model requests receive only confirmed authorized memory as user context. Agent proposals and unauthorized-provider entries are excluded. No external output becomes a system instruction. |
| P07 Arena | real commands, broker budget, per-trial copied workspace, independent verification and raw sample metrics | Pick Squad templates. Server freezes exact template revision, roster, instructions and policy into isolated trial rooms. Source-room authorization must already include every candidate member; the UI explains unavailable candidates. Existing live-mode authorization, leases and per-request revocation checks remain. |
| P08 upgrade/recovery | pre-write compatibility, additive checksummed migrations, retained histories | Migration039 adds preset and frozen attribution metadata plus accepted verification-run references. Old migration checksums are unchanged; upgrade/reopen tests preserve prior room/message rows. |

No P00–P08 feature was merely a type stub at this baseline. New hooks were unnecessary. Unimplemented measured success probabilities, learned routing policy, cross-machine billing reconciliation and a calibrated cross-task quality score are not advertised by M06. Arena observations remain exploratory samples, not a production ranking or an automatic policy change.

### License and component decisions

- `reuse_existing`: Socrates `CostLedger`, `TaskQuoteService`, `RoomCommandService`, `VerificationControls`/`VerificationPanel`, `ProjectMemoryService`, Flight Recorder, Arena and foundation `DetailPanel`/`ErrorNotice`. Only domain bindings and scoped read/UI glue were added.
- `reuse_existing`: installed `@base-ui/react` **1.9.0**, actual package `LICENSE` is MIT; installed directory approximately **20 MB** uncompressed, already in the application. Existing foundation portals and accessible controls retain Tauri/React/Vite integration, tested in Chrome and the production build.
- `reuse_existing`: installed `@opentelemetry/sdk-trace-base` **2.6.0**, actual `LICENSE` is Apache-2.0; approximately **1.5 MB** installed uncompressed. Existing recorder is reused; no exporter or network service added.
- `reimplement_product_specific`: versioned Squad policy and immutable command attribution, using current Bun SQLite migrations and current service seams.
- `defer`: importing Multica code/assets. Re-read `/private/tmp/socrates-multica-source-audit/LICENSE` Part I (hosted/embedded and UI-branding restrictions) and `packages/core/types/squad.ts` (stable Squad/Leader/activity identity). This sparse local snapshot has no `.git`; its HEAD cannot be freshly verified. The older audit's pinned revision is historical evidence only. No Multica source, UI, assets or services were copied or executed.
- No new dependency, lockfile change, query-cache framework, drag/drop library or alternate execution runtime.

## Accounting and state invariants

Each scoped total queries unique physical invocation rows and applies the existing reconciliation rules. Agent, Squad, WorkItem, Package and Project are overlapping dimensions: never add their totals together. Tool events do not become an extra model charge. Retries retain their own attempt charges. Existing currency separation and reference-estimate labels remain.

Squad ownership is frozen at command admission, including prepared WorkItem rooms and authorized Arena rooms. Reassignment, template edits and rebinding do not transfer previous charges. The pre-M06 past cannot be reliably attributed to a Squad after a historical rebind; those costs remain in the existing room/project/agent ledger, with no invented Squad backfill. No invocation means no recorded model call; unknown price or missing usage means unknown, never `$0.00`. Historical rows not attributable to an entity are not presented as measured zero cost.

Agent prose, execution completion, independent verification and human acceptance remain separate. An accepted item with changed verification artifacts projects `in_review`, retains its old review history and rejects reacceptance until checks pass or the existing explicit unverified-acceptance flow is used. A new verification run needs a fresh review. Budget-interrupted execution remains in progress with a reason; it is not hidden or marked done.

The new read-only panels show original quote, budget, models/attempts, price snapshot IDs and unknown reasons. Existing execution-room controls retain approval, budget increase and resume authority. Verification remains a real service action from the task detail; opening reports/recordings does not call models.

## Validation

- Full suite: **1320 passed, 0 failed, 24169 assertions, 228 files**, 43.80s; `/private/tmp/m06-final-suite.log`.
- Focused M06 + migration run: **13 passed, 0 failed, 85 assertions**. Seven M06 real-service tests cover scoped deduplication/reconciliation, frozen rebind ownership, actual routing and zero-budget rejection, stale human acceptance, same-room approved preflight verification, authorized Leader/worker memory, and actual isolated Arena Leader dispatch.
- Root typecheck and lint pass. Desktop production build passes; its existing chunk-size/mixed-import warnings remain.
- Real Chrome: **11/11 checks pass**, zero renderer errors and zero external browser requests. Evidence: [checks](assets/multica-m06/checks.json), [task evidence](assets/multica-m06/task-cost-verification.png), [budget stop](assets/multica-m06/budget-stopped.png), [650×600 task](assets/multica-m06/task-narrow.png), [Squad policy](assets/multica-m06/squad-policy-cost.png), [Arena](assets/multica-m06/arena-squad.png), [SHA-256 manifest](assets/multica-m06/sha256.json). Screenshots were visually inspected. Temporary SQLite, workspace and controlled model streams only; no real provider credentials, paid requests or production data.
- Initial ordinary execution of the Arena suite encountered macOS `sandbox_apply: Operation not permitted`; rerunning with host permission passed. The first full run also identified two literal migration-version test expectations, updated for039. Browser development exposed a missing select accessible label (fixed). Its later Arena selection failure was a test choosing the default single-member room; explicitly selecting the authorized source room preserved the product's permission check.

## Reproduce

```sh
bun test
bun run typecheck
bun run lint
bun run --cwd apps/desktop build
bun run --cwd apps/desktop dev --host 127.0.0.1 --port 45379 --strictPort
bun scripts/multica-m06-browser-fixture.ts
SOCRATES_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node scripts/multica-m06-browser.mjs
```

The fixture writes synthetic metadata to `/private/tmp/socrates-multica-m06.json`; stop its recorded PID and only the Vite process started for this check. The fixture cleans its own database/workspace on SIGTERM/SIGINT. Chrome closes in the test's finally handler.

Not checked: paid providers, installed Tauri release, OS screen reader/IME or M07 scale/stress. Nothing merged or released by this stage. Existing performance concerns in list projection/polling belong to the next measured acceptance stage.

## M06 scoped-review correction

The first scoped review reproduced two missing transitions despite the earlier1320-test/11-browser result: a separate package's stale evidence did not invalidate the root human acceptance, and evidence invalidation masked an explicit request for changes. Those earlier checks did not cover these transitions.

`VerificationService` now produces one effective evidence revision from the root and all current package evidence, preserving the existing adaptive-attempt exclusion and explicit unverified-acceptance gate. Migration040 stores that revision with each WorkItem review; old checksums and review history remain unchanged. An accepted item reopens on a failed gate or any acknowledged evidence revision change, even when a child was reverified before the item was polled. Successful re-verification cannot restore an old acceptance. An explicit `request_changes` remains the human decision through stale evidence and later reruns.

Previously recorded root verification reviews lacking the full revision conservatively require one fresh human acceptance after upgrade. Plain unverified reviews without recorded root evidence retain their existing behavior. The existing explicit acceptance of an unverified root/package still permits a new WorkItem human acceptance, without claiming the result was verified.

The reviewer reproduction now reports `in_review/pending` for stale package evidence, remains `in_review` after the package rerun, and returns `todo/changes_requested` after explicit rejection. Focused regressions use separate `context.txt` root and `child.txt` package artifacts and also check an unobserved child rerun and explicit unverified acceptance. Exact final checks are appended to the stage report; no frontend code changed, so the11 Chrome checks remain the earlier UI evidence rather than a claim to cover these backend transitions.

Final correction validation: **1322 pass / 0 fail / 24185 assertions / 228 files / 43.31s** (`/private/tmp/m06-review-final-suite.log`); covering41/223, root typecheck, lint588, desktop build2.83s and diff-check pass. One initial broad run hit an unchanged macOS process-runner deadline; isolated14/14 rerun and final full rerun passed without changes to that subsystem. Paid providers and installed/native app were not retested.
