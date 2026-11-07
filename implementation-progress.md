# Socrates cost-aware implementation progress

Latest follow-up (2026-11-07): automatic official reference prices and estimated presets, optional one-model overrides, and separate historical reference estimates. Current gate: 998 tests passed, zero failures; typecheck/build and 11 automatic-pricing Chrome checks passed. Prior startup/permission repairs and their original evidence remain below.

## Working baseline

- Date: 2026-11-06 (Asia/Singapore). RUN_SCOPE=P00-P02.
- Starting commit: `e374dd3` on `codex/readme-persona-studio`; implementation branch: `codex/cost-aware-p00-p02`.
- Prompt reference `8f5fa212` is older. Current checkout already contains canonical Chat/Work sessions, durable command/member snapshots, observable Native retries, work packages/review/leases and room lifecycle repairs. These were reused, not reimplemented or reset to Alpha.1.
- Existing `.reasonix/desktop-topic-auto-title-meta.json` modification, untracked prompt, `.playwright-cli` and prior Playwright artifacts were preserved. Prior contents of `task_plan.md`/`notes.md` remain; this work is appended.
- No paid model request, production credential access, private upload, push, merge or publication. Initial P00-P02 tests used only temporary databases/workspaces. The later startup repair verified an isolated copy and then applied a consistent-backup-protected 024 upgrade to the local database, as recorded below.
- Baseline verification: `bun test` 881 pass / 4 nested-macOS-sandbox skips / 0 fail; `bun run typecheck` passed. These are baseline counts, not final change counts.

## Stage status

| Stage | Status | Actual implementation/evidence |
|---|---|---|
| P00 | completed for RUN_SCOPE | Shared physical-request broker; official Responses adapter; provider/model capability validation; executable models.dev/LangGraph/OTel/promptfoo checks; ADR 0009 |
| P01 | completed for tested text/token coverage | Fixed-precision pricing and immutable snapshots; provider-aware usage/raw terminal fields; exact invocation ledger; reconciliation/export; provider/room UI; unsupported modalities explicitly unpriced |
| P02 | completed for RUN_SCOPE | Local bound quotes; root/ancestor atomic reservations; strict/soft/tracking policies; same-task budget pause/topup/requote/reduced-output resume; real team/Chat/browser checks |
| P03–P08 | outside RUN_SCOPE | No adaptive routing, verification-success claim, memory or Arena delivery claimed |

Final full repository gates and browser checks passed as recorded below; no historical acceptance count is reused as current evidence. Coverage limits remain explicit at the end of this document.

## Production call-chain audit and identity

| Path / owning function | Broker entry / purpose | Recovery/fee behavior |
|---|---|---|
| RoomCommand direct → RunSupervisor → SingleAgentRunner → Native | `createAiSdkNativeStream.openAttempt` / respond or execute | Every sample and explicit retry is a new invocation, output cap sent to SDK; same turn/root on continuation |
| RoomCommand discussion / configured summary | Wrapped ModelGateway / respond, summarize | Completed member messages replay from durable idempotency keys; no duplicate user message or fee |
| Coordinator discussion / synthesis / schema repair / user replan | Wrapped ModelGateway / respond, plan | Frozen member profile; each real request recorded; persisted user revision boundary survives budget pause/restart |
| Plan reviewer / package reviewer | Wrapped ModelGateway / review | Same root; package reviewer also carries workPackageId; blocked review keeps completed work and does not grant approval |
| TeamRunner → ExecutionRunner child | Native per-attempt broker / execute | Original child run/package identity, shared parent task account; serial workspace write lease; resumed tool facts are not replayed |
| ContextCompactionService | Local deterministic compaction, no LLM | No hidden summarization/model request or fee |
| Legacy `rooms` orchestration | Migrated writes reject with canonical session mapping in production | New production calls use RoomCommand/Native. Old standalone route fixtures remain backward compatible; old history/tokens are not repriced |
| Memory/classifier/Arena/new paid paths | Not active in this scope | Must enter the same broker when later introduced; no uncalled adapter is described as a completed product feature |

`GatewayInvocationContext` carries room/root/run/member/provider/profile/logical step identity. Physical `InvocationIdentity` adds invocation ID, attempt, price reference and correlation IDs. SDK internal retries stay `maxRetries:0`; Native's existing retry policy invokes the broker separately for each attempt. Current Provider enabled state, room membership/execution eligibility, archive/revocation and credential availability are checked before dispatch. The old Native loop is still the sole tool loop.

## Reuse decisions

Full source/version/license evidence, actual import locations, rerun commands and the native SQLite failure are in `doc/cost-aware-reuse.md`.

- `direct_dependency`: official `@ai-sdk/openai` 4.0.10 selects Responses only for exact official HTTPS `/v1`; existing compatible/Anthropic SDKs remain. Fetch contract fixtures exercise actual SDK serialization/parsing, tools/call IDs, reasoning, caps, final usage and request IDs. No live model entitlement/result is claimed.
- `data_reuse`: real models.dev frozen subset, hashes, source commit and MIT notice. `PricingStore.importBundledModelsDev` is reachable from HTTP and provider UI, with explicit proxy mapping confirmation. Bundled coverage is one verified `openai/gpt-5` record; all other models require confirmed custom prices or remain unknown. No per-message price lookup or hidden network request.
- `direct_dependency` + `adapter`: existing LangGraph.js 0.2.74 / checkpoint 0.0.18, durable Bun SQLite saver. Actual child-process interrupt/reopen/resume/duplicate-resume/cancel experiments call RoomCommandService once. Official SQLite saver 0.1.5 failed `better-sqlite3` 11.x native compilation on Node 26; reproducible failure and replacement adapter are documented. Production team orchestration is not migrated or doubly owned; P04 can use the verified seam.
- `direct_dependency`: OpenTelemetry API 1.9.0 + SDK trace-base 2.6.0. The broker records actual committed service events as SDK spans. Exporter is absent by default, environment exporter settings ignored, metadata allowlisted, payload/key/reasoning excluded.
- `adapter`: actual promptfoo 0.125.1 `evaluate()` in isolated `scripts/reuse` development package runs a full Socrates task and deterministic assertion: one success, zero failures, usage 10/5/15. Network/telemetry/sharing disabled. This proves a full-task interface; it is not P07 Arena or an economic benchmark.
- Existing Zod validates external pricing; Bun FTS5 is exercised with a project-filtered query. Existing diff and React/Zustand UI remain. assistant-ui and Langfuse export are `reference_only`, not claimed as adopted functionality.
- Money, permissions, price matching, ledger and budget policy are necessary `custom_domain_logic` owned by Socrates.

## Prices, usage and money

- Ledger scale is 12. BigInt arithmetic; atomic integer strings cross JSON. No floating sum is used as budget truth.
- Exact price identity: connection + upstream/model + endpoint/protocol + service tier + currency/rate rule. User-confirmed connection price wins over official/verified catalog; snapshots are immutable and hash/version/source/time/validity retained. All conflicting versions remain visible in provider price details.
- Text/token adapters split inclusive cache read/write from ordinary input and do not double-count reasoning contained in output. Provider semantics can explicitly differ. SDK-supported raw terminal chunks recover only minimal numeric accounting fields lost by older normalized schemas; raw messages/reasoning are discarded.
- Missing distinct cache quantities, 12-hour writes, unmatched returned service tiers and unsupported modalities stay partial/unknown. Unknown models, subscription/local billing without confirmed increment rules and missing prices are not free. Multi-currency summaries stay separate; enforcing budgets require USD and have no implicit FX conversion.
- Typed image/audio/video/file input is refused before dispatch in guarded tasks because only text billing is verified; unguarded/explicit tracking-only calls retain usage with no applied text-price snapshot and an unsupported-modality reason. Plain text resolved from selected text files remains text. JSON exports keep canonical data; CSV text fields are neutralized against spreadsheet formulas while integer amount columns stay exact.
- Request-time price applicability is checked against invocation creation. Expired offline fallback does not produce a false known charge. A response finishing after expiry still uses the tariff valid when sent. New prices do not rewrite historical facts.
- Provider usage × rate is labelled computed provider usage, not a final invoice. Manual invoice confirmation appends an idempotent adjustment/reconciliation; original usage, price and amount stay visible. CSV/JSON exports omit conversation/file/key content and include original/reconciled/effective cost, pricing identity, currency, unknown count and generation time.

## Budgets, quotes and resumption

- Local TaskQuote has task/member/config/provider/history/file-reference bindings, price snapshots, output cap, heuristic stages/unknowns, revision hash and ten-minute expiry. No model is called for preview. Server rejects stale bindings before task/history creation.
- Stages include Manager planning/repair, bounded discussion/summary, execution, review, retry allowance and explicitly uncovered external paid tools. Ranges are heuristic, never statistical confidence intervals or measured savings.
- Accounts begin before the first paid preparation call. Reserve transaction checks every ancestor; strictest ancestor determines the amount's bound. `available = limit - settledKnown - activeReservations - unresolvedExposure`.
- A possibly sent request retains exposure on disconnect/crash. Only confirmed-unsent reservations release. Known partial costs and unresolved remainder are counted once. Actual costs above a reservation/cap are recorded in full, emit breach and pause later calls; they are never clipped to the limit.
- Strict mode needs verified official model context maximum/provenance and executable output cap. Effective user overrides and character heuristics do not establish strict bounds. Soft mode uses disclosed byte estimates; tracking-only is an explicit record-only choice. Unexpected billing rules pause guarded future sampling. Unpriced external MCP tools are denied in guarded tasks and disclosed in quote scope.
- Monetary budget reasons are separate from step exhaustion, cancel, Provider quota/rate limits and unknown outcomes. Pauses release workspace leases. Same-root resume can increase budget or lower output cap and creates an explicit new quote/configuration event. Completed tool effects/packages/turns survive; retrying the increase or resume request does not reset consumption or duplicate a task.
- A lost command HTTP response retains its original request/quote envelope even if UI later refreshes the quote. Definite quote rejections permit a new envelope. Room/revision guards reject late quote/cost responses after switching rooms.
- Current scope keeps running member/model identity fixed. Users can choose cheaper authorized members before a future task/plan approval; mid-run reassignment of an already started package/direct turn is not introduced. Existing plan-stage assignment, `@` identity, tool approval and stop/preserve-result controls remain authoritative.

## Migration and retained data

- Version `023_cost_accounting` establishes the price/invocation/budget tables and is frozen to its first applied checksum. Append-only `024_cost_accounting_completion` adds durable actions, invoice totals and legacy observation capture. The known complete-023 variant is recognized only with its actual schema; unknown checksum drift stays fatal and applied migration metadata is never rewritten.
- Accounting does not cascade with room/history rollback/deletion. Existing messages, authors, members, room IDs and token rows remain unchanged. Historical null-cost observations are captured as unknown and are not repriced with today's rates.
- `openDb` makes a consistent backup before pending migrations. Upgrade tests cover populated v22, early 023 and complete 023 files, backup/data/token preservation and repeat opens. The subsequent local repair applied 024 after backup, preserving all records in 12 protected tables, including 4 rooms and 8 session messages.
- There is no automatic ledger purge or cloud bill download. Explicit permanent anonymization/purge is a separate future privacy operation; local minimal audit identity remains retained by design.

## Current verification evidence

- `services/cost-flow.integration.test.ts`: actual RoomCommand → Coordinator → plan approval HTTP → TeamRunner → ExecutionRunner → AI SDK Native → builtin write/read → monetary pause → lease release → topup → same-task resume → reviews.
- Under explicitly synthetic USD 1/M input/output rates: six charged invocations (plan + three Native samples + two reviews), known USD 0.000900, unknown count zero. `write_file` count stays one across resume; no lease remains. This is deterministic fixture evidence, not real Provider pricing or a saving claim.
- Direct Chat continuation: known USD 0.000150, one public user input, no workspace tools. Discussion/configured summary shares the same budget and avoids repeated completed member turns. Missing Native usage after a real temporary write retains exposure across DB reopen; topup alone does not replay it.
- Tests include T01 USD 0.00805 inclusive cache/reasoning example, T02 USD 1 budget arithmetic and two independent Bun processes competing for USD 0.60 reservations, parent strict/child soft, duplicate finish/increase, price updates/expiry, unknown cache/tier, currency reconciliation, interrupted-package recovery and persisted Manager replan.
- `routes/cost.test.ts` exercises real HTTP quote/command/ledger/invoice/export/price validation. Exports exclude sentinel conversation and fixture credentials; original amount and explicit invoice adjustment remain distinct.
- Browser evidence: `output/playwright/cost-aware/` (checks JSON, six screenshots and actual CSV/JSON downloads), driven by `scripts/cost-aware-browser.mjs` against `scripts/cost-aware-fixture.ts` with only controlled provider fetches. Final **20/20** checks passed: real quote/plan/write/read/budget pause; lost committed HTTP response retains one command; double-click topup; lower cap 128 and same-root resume; exact six-call total; exports exclude conversation; late-quote room isolation and IME confirmation; unknown exposure and explicit manual invoice; custom/catalog price import preserves history; dark/light narrow layout; **zero renderer exceptions and zero external browser requests**. Own Vite, browser and fixture processes were stopped and temporary data cleaned.
- Additional real reviewer-stage test pauses a completed Worker at its separately priced Reviewer, retains `awaiting_review`, releases leases, and resumes review without rerunning Worker writes. Concurrent resume with identical request/cap has one owner; a conflicting cap under the same request ID is rejected.

## Original cost-aware gates (before startup repair)

All final gates ran against the resulting source:

| Check | Result | Durable evidence |
|---|---|---|
| `bun test` on host, including macOS command-isolation fixtures | **971 pass / 0 fail / 0 skip**, 175 files, 22,148 assertions | `output/validation/cost-aware/bun-test.log` |
| `bun run typecheck` | exit 0 | `output/validation/cost-aware/typecheck.log` |
| `bun run --cwd apps/desktop build` | exit 0; existing Tauri static/dynamic import and large-chunk warnings | `output/validation/cost-aware/desktop-build.log` |
| Real Chrome fixture checks | **20/20**, zero renderer errors/external requests | `output/playwright/cost-aware/checks.json` and six PNGs |
| Actual promptfoo `evaluate()` | 1 success / 0 failures, one task, 15 tokens; network forbidden | `output/validation/cost-aware/promptfoo.log` |
| `git diff --check` | clean | verified after source changes |

Machine-readable summary: `output/validation/cost-aware/summary.json`. No native Tauri WebView/download behavior, live provider entitlement/usage bill or real paid model response was verified. Browser proof uses the real application React UI and owning business services with only external model/fault responses controlled.

## Reproduction and next steps

```sh
bun install
bun test
bun run typecheck
bun run --cwd apps/desktop build
# optional isolated full-task evaluation experiment (not a shipping dependency)
bun install --cwd scripts/reuse --ignore-scripts
bun run --cwd scripts/reuse promptfoo
# browser fixture uses a fresh temporary DB/workspace and no live model
bun run scripts/cost-aware-fixture.ts
# follow scripts/cost-aware-browser.mjs for fixture/Vite arguments
```

For normal use: start with `bun run dev`; configure a Provider in Settings, confirm connection-specific model rates (or explicit supported catalog mapping), then enable the task budget in the composer, review its quote and submit. A paused task exposes increase/resume and invoice reconciliation where needed. Output allowances are managed by the application. Existing rooms keep single/team/member choices and budgets remain opt-in.

Remaining validation/coverage limits: no paid Provider or native Tauri-window verification; catalog is deliberately narrow, tested text/token rules only; generic/proxy strict bounds not asserted; unpriced external MCP excluded from guarded tasks; no mid-run model replacement or permanent ledger purge; P03-P08 remain future authorized scopes. These are not represented as completed capabilities.

## Follow-up: sidecar startup repair (2026-11-06)

- The user's screenshots showed connecting followed by sidecar startup failure. Read-only local metadata showed early 023 checksum `c31ffcef...`, but the edited definition expected `04bbe3e3...`. Missing actions/legacy tables and invoice-total column confirmed the earlier schema. An isolated consistent copy reproduced `migration_checksum_mismatch:23` exactly. This was a migration compatibility defect in the implementation; earlier empty-database/business-fixture checks missed the real startup path.
- Freeze original 023 and append 024. Recognize the known complete-023 checksum only with its actual schema, without rewriting applied migration records. Unknown checksums/incomplete claimed variants remain rejected. Already captured legacy cutoffs are not recaptured. All prices, consumption and invoice adjustments remain intact.
- Frozen regression fixture `store/migrations/fixtures/023_early_cost_schema.sql` contains DDL only, no user records. Tests cover both known 023 variants, data/fee preservation, backups, idempotence and invalid checksum/schema rejection.
- `startup.test.ts` launches the actual sidecar entry in a separate Bun process from the desktop working directory, against a temporary early-023 database. It verifies stdout handshake, authenticated health 200, unauthenticated 401, existing room load, capabilities, cost projection and version 24. No Provider, MCP or production credential is used.
- The local database's isolated snapshot upgraded with all 12 protected tables unchanged. The actual database then received only the backed-up schema completion: original 023 checksum retained, 4 rooms and 8 session messages preserved. The version-23 backup is retained in the local application-data directory; its exact path remains in local validation evidence. Evidence: `output/validation/sidecar-startup-fix/database-repair.json`.
- A real `bun run dev` Tauri launch with a separate empty temporary data directory reached the desktop binary and spawned its sidecar. CUA cannot bind the unbundled development binary, so rendered native UI behavior is not claimed. Temporary Tauri/Vite/sidecar services were stopped and disposable data cleaned. Restart the user's normal app with `bun run dev` to use the preserved original rooms.
- Final gate: **975 tests passed, 0 failed, 0 skipped**, 177 files, 22,171 assertions. Typecheck and desktop build passed. Logs and machine-readable summary: `output/validation/sidecar-startup-fix/`. No model request, production key use, external upload, push or publication occurred in this repair.

## Follow-up: Chat settings and automatic planning output (2026-11-06)

- Read-only diagnosis of the reported Chat room confirmed three current members but a stored empty discussion speaker order. The settings modal rendered only that empty array, so enabling discussion violated `discussion_speaker_order_required` with no way to populate it. Reuse core `resolveCollaborationDefaults` when creating the editable draft: fill empty defaults from the room roster, preserve an explicit valid subset/order and summarizer, and show validation errors next to Save. Nothing is written until the user saves.
- Read-only diagnosis of the failed team task confirmed two `length` finishes at exactly 1,024 output tokens. The first had 1,024 reasoning tokens and zero content characters; the second had 1,008 reasoning tokens and only 37 content characters. The broker's newly introduced 1,024 default, combined with retrying invalid JSON under the same cap, caused this failure. No research request from the screenshot was executed during diagnosis.
- The user explicitly requested application-managed output limits. This supersedes the earlier manual-cap UI design: the composer and budget-resume panel no longer ask for token limits. Users set monetary budgets. Legacy explicit API caps and API-only reduction on resume remain supported and binding.
- Automatic requests start with an 8,192 allowance and have a 32,768 internal ceiling. The broker supplies the actual limit/ceiling in the gateway completion contract. A known truncated planning response can spend the existing single repair attempt on an increased allowance; every physical attempt gets separate price/reservation/admission and usage facts. A legacy explicit cap cannot be bypassed. Unknown remote outcomes are never auto-expanded/replayed. If expansion exceeds available money, the same root task pauses before the request is sent.
- Commit completed planning usage and its finish metadata in one SQLite transaction using the existing EventStore. Restart/resume reuses the completed first turn and its intended larger repair allowance. Schema/assignment failures still get one repair with actual validation codes; complete plans retain exact approval, member eligibility and dependency validation. Existing failures now have a localized explanation, while prior ledger facts/history are preserved.
- Regression evidence uses the actual AI SDK with a controlled compatible-provider SSE response, production broker, coordinator, quotes, budget ledger, HTTP routes and temporary SQLite/workspaces. Tests cover an all-reasoning truncated response, explicit cap preservation, automatic expansion to a valid plan, monetary admission pause, topup/same-root resume, no duplicate completed turn and no execution before plan approval. UI tests cover both the old Chat/member shape and the full quote/Native tools/exports/manual-invoice flow.
- Final checks: **983 tests passed, 0 failed**, 177 files, 22,208 assertions; typecheck and desktop build passed; **32/32 Chrome checks** (10 reported-regression checks + 22 full cost-flow checks), zero renderer exceptions and external browser requests. The earlier red tests reproduced the defects before fixes. Logs/diagnosis/summary: `output/validation/collaboration-regression/`. UI evidence: `output/playwright/collaboration-regression/` and `output/playwright/cost-aware-auto-output/`.
- This repair read the actual application database only; all mutations/tests were isolated. No live/paid model, production credential use, private upload, push or publication. Native Tauri WebView rendering and real provider billing remain unverified. No new migration is required: finish metadata reuses the durable event schema. Next user action: restart the development app and resubmit the failed task to use automatic output management; existing failed task records and charges are retained. P03-P08 remain outside this run.

## Follow-up: failed writes and session permission (2026-11-07)

- Read-only inspection found three failed `write_file` calls against an absent target. Their supplied `expectedSha256` values were respectively an all-zero hash, an unrelated hash and the empty-file hash. Each call had already received `allow_once`; the write itself rejected the nonexistent preimage with `WORKSPACE_FILE_CHANGED`. The failure was a tool-input/precondition problem, not an unapproved file mutation. The current team task is paused; no production task was resumed and no model was called during this repair.
- `write_file` now explicitly documents `expectedSha256: null` as create-only, accepts it in the published schema and checks it atomically against absence. Updates use the full hash returned by the existing `read_file`; stale hashes remain rejected and cannot silently overwrite. Missing/existing target conflicts retain the stable error code and give concrete corrective instructions, so a controlled Native model loop can correct its input rather than repeat invented hashes. Legacy omission retains the previously approved unconditional-write behavior.
- The session button had two defects: frontend visibility checked only `freshHumanRequired`, while the backend rejected all `high` risks; persisted grants were never consumed by subsequent runtime calls. Reuse the shared core approval predicate for both UI/backend, and allow an explicitly scoped session grant for the six named non-destructive built-in workspace writers. The risk label stays high. Commands, deletes/moves, plan-scope expansions, hard denials and unknown-outcome confirmation remain outside this grant.
- Append-only migration **025** adds nullable `session_id` and `tool_generation` to approval requests plus a scope lookup index. Previously applied migration definitions remain unchanged. New Native approvals carry actual tool name/generation and room identity. Grant lookup binds room, workspace identity, tool name/generation, risk, policy version and expiration. Old records/grants are preserved; missing metadata does not become a broad grant. Upgrade/reopen/idempotence tests retain the historical rows and demonstrate new scoped grants survive SQLite reopen.
- Both direct and team hosts consume grants only after normal permission and plan-scope checks. Each subsequent concrete call still records an exact request and `allow_once` decision with reason `session_grant`, then uses the existing Native approval delivery/input-hash checks. A plan expansion is still marked fresh and requires the user's one-time decision. No second executor, bypass around ToolExecutor or new dependency was introduced.
- Actual AI SDK + controlled SSE integration verifies one wrong-hash failure receives actionable feedback, then two temporary files are created with corrected arguments after one session decision. Team integration verifies the second in-plan write is automatic and an out-of-plan third write remains blocked until exact approval. Real Chrome clicks **Allow for session**, observes both approved writes, verifies no broad button on scope expansion, then clicks **Allow once** and observes task completion: **8/8 checks**, zero renderer errors/external requests.
- Final checks: **990 tests passed, 0 failed**, 179 files, 22,258 assertions; typecheck and desktop build passed; `git diff --check` clean. Earlier red tests reproduced null-precondition rejection and the backend session-scope rejection. Evidence: `output/validation/write-permission/` and `output/playwright/write-approval/`.
- The actual database/workspace was read only; all writes and approvals used isolated fixtures. No live or paid model, production key, upload, push or publication. Native Tauri rendering/live provider continuation remains unverified. Restart the application to load migration 025 and the new sidecar; then recover the paused work package. Existing rooms, files, task history, approvals and accounting facts are retained. The repair does not automatically resume a task or incur model charges.

## Follow-up: automatic prices instead of per-call bill entry (2026-11-07)

- Read-only diagnosis found finished calls with recorded token usage but no price snapshot; all observed unknown items were `price_unknown`. The prior UI grouped missing prices with uncertain remote results and exposed per-invocation bill forms. This incorrectly made normal use look like manual invoice entry was required.
- Verified primary API/billing documentation. OpenAI/DeepSeek model-list responses do not publish unit rates; OpenAI administrative cost APIs are distinct from standard per-request pricing. OpenRouter is an example of a service that publishes model pricing metadata. This implementation uses an offline, versioned official reference bundle for the configured OpenAI/DeepSeek models, not a speculative price API or inference request. Full source links, exact coverage and limits: `doc/automatic-model-pricing.md`.
- Reuse the existing PricingStore, quote service, invocation broker, ledger, provider form and immutable snapshots. Automatic resolution prioritizes user-confirmed model overrides, official reference rules and verified catalog data, then an explicitly estimated preset. Known OpenAI model names on a proxy receive only an unverified proxy estimate. Generic unlisted-model defaults are USD 1 / 5 per million input/output tokens (cache references 1), clearly editable estimates. This is never a claimed provider tariff or free usage.
- Current official coverage includes the user's `gpt-5.6-luna`, `gpt-6-luna` and documented `deepseek-v4-flash` alias, plus the verified GPT-6 Astra/GPT-6.1 Sol/Terra and DeepSeek Pro reference entries. Include cache reads/writes, the >272K OpenAI input tier and DeepSeek UTC bands. Peak references explicitly do not claim exact Chinese holiday-calendar handling. All arithmetic stays decimal strings/bigint; rates have source/version/verification/validity metadata.
- New reference/preset-priced invocations record `estimated` consumption. Known totals and estimated totals are separate; both known and booked estimated money reduce soft-budget availability. Strict admission still rejects unverified presets; unsupported dimensions, currency restrictions and unknown execution outcomes retain their guards. A later explicit invoice converts estimated consumption without double counting. Each physical request still freezes its snapshot; changing a model rate affects later calls, not earlier bound charges.
- Historical finished calls with complete usage but no price can expose `referenceEstimate` at the current reference rate. Original status, amount, snapshot ID, usage and timestamps stay intact; these current-reference views neither claim historical invoices nor release old unresolved reservations. CSV/JSON exports separate original values, current-reference estimates and snapshot versions.
- UI: automatic amounts in the collapsed cost heading and per-member/detail views; distinguish reference estimates, missing prices, incomplete billing and uncertain outcomes. No per-call invoice form for ordinary reference-priced calls. Provider settings automatically load/prefill applicable model rates, show source/date and source links, and permit a single model override. Manual invoice reconciliation remains for genuine missing/uncertain usage. No new dependency, migration or unused adapter was added.
- A consistent isolated copy of the real database projected estimates for **26/26 calls**, with **15 protected tables unchanged**. The actual application database was opened read-only; private copied data was not uploaded and was deleted after validation. Derived evidence only: `output/validation/automatic-pricing/isolated-copy.json`.
- Final gates: **998 tests passed, 0 failed**, 180 files, 22,294 assertions; typecheck/build passed; **11/11 real Chrome checks**, zero renderer errors/external browser requests. Checks exercise automatic amounts, no bill forms, reference exports, prefilled official rates, a single model override applied through the production broker to a later controlled call, unchanged original history and unchanged previously frozen charges. Evidence: `output/validation/automatic-pricing/` and `output/playwright/automatic-pricing/`.
- No paid/live inference, production credential use, actual database mutation, private upload, push or publication. No live OpenRouter catalog adapter, automatic administrative bill download, exact holiday calendar or native Tauri WebView verification is claimed. Future work: expand verified provider coverage and add an explicit public-catalog refresh path. Restart the app to load the updated sidecar; normal pricing requires no per-call entry. P03-P08 remain outside this run.

## PR submission (2026-11-07)

- The user subsequently authorized submitting all outstanding implementation work as a PR. Track the combined P00–P02 delivery and reported regressions in [issue #142](https://github.com/Haosen-Zhang/Socrates/issues/142), on `codex/cost-aware-p00-p02` based on current `main` after merged PR #141.
- Re-ran the standard gates immediately before submission: **998 tests passed, 0 failed**, 180 files, 22,294 assertions; typecheck and desktop build passed. The opt-in actual promptfoo evaluation again passed with one controlled command and outbound fetch forbidden. `git diff --check` is clean.
- Publish implementation, migrations, regression tests, reproducible fixture scripts, dependency locks, architecture/decision documents and a [sanitized acceptance record](doc/cost-aware-acceptance.md). Controlled screenshots/check lists use fictional test data. Original user-supplied prompts, the pre-existing local metadata edit, browser caches and raw host/private-data validation outputs remain local and unchanged.
- This authorization covers code submission only. No paid model, private-data upload, merge, release or deployment is part of this submission.
