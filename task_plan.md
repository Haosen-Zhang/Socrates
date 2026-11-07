# Chat / Work and room-member collaboration

Base: origin/main e13de16. Branch: codex/chat-work-member-collaboration.

## Design and execution
Preserve the existing React/Tauri/Bun product, Native Runtime, event and recovery authority. Room kind (chat/cowork), persistent members, explicit collaboration strategy and per-command targets remain independent. New Chat rooms use sessions without workspace or tools; existing legacy rooms remain readable. Commands persist structured mentions and stable request identity. Member snapshots freeze template configuration, run profiles freeze execution. Team work packages reuse native execution and a single workspace writer queue.

## Phases
- [x] A1 Inspect current main, architecture and user requirements; isolate branch; preserve .reasonix changes.
- [x] A2 Frozen profiles, honest budget interruption and shared workspace leases.
- [x] B Chat/Work navigation, room drafts, inline reusable role editor and member configuration.
- [x] C Structured command routing, idempotency, bounded discussion and room isolation.
- [x] D Persistent work packages, distinct owners, dependency execution, review, stop and recovery.
- [x] E Full test/typecheck/build gates, UI verification and document synchronization.

## Ownership
- runtime_foundation: native and member runners, profiles, leases.
- frontend: desktop components and state.
- team_execution: coordinator, team/work-package persistence and routes.
- root: room commands, sessions, migration registration, production wiring, integration and docs.

## Validation
Meaningful route/config/state/lease/recovery tests plus reproducible two-member team execution including failure and retry. Run bun test, bun run typecheck, bun run --cwd apps/desktop build and browser interaction checks. No supplied provider credential; mocked-provider evidence is reported separately.

## Findings / constraints
- Local main was behind; fetched remote and started at latest e13de16.
- Sandbox gh check initially reported invalid auth; host recheck verified authentication. The user subsequently requested PR publication; tracked as GitHub issue #136.
- Initial sandbox git fetch denied .git write; authorized escalation succeeded.

## Status
Completed A–E. Final host gate: bun test 828 pass / 0 fail, including all four macOS command tests. Typecheck and desktop build pass. Targeted lint covers changed TS/TSX. Twelve browser checks passed with no page errors. No real Provider API or native Tauri window verification.


## Verification history
- One earlier concurrent sandbox test run hit the existing command-runner 100 ms deadline in `stops background mutations before returning a normally exited leader’s result`; isolated retry and later full host suites passed. No timeout thresholds or production process policy were loosened.
- Playwright CLI wrapper was not executable and its daemon socket was unavailable between calls; validation used the installed Playwright module in an isolated Chrome process. Temporary browser diagnostics were removed; passing evidence remains in output/playwright.
- Final review P2 findings (unknown-package recovery confirmation; hidden team discussion error) fixed with regression tests.

---

## Prior development record (preserved)

# Task Plan: Socrates proxy and product polish tickets

## Goal
Ship the reported proxy, provider form, composer, agent, room sidebar, and pixel-theme improvements as reviewable one-ticket branches and pull requests, each with regression coverage and green project checks.

## Phases
- [x] Phase 1: Synchronize `main`, inspect current behavior, and create GitHub tickets
- [x] Phase 2: Fix macOS auto proxy discovery and provider type/model selectors
- [x] Phase 3: Fix IME-safe composer behavior and Reasonix-inspired pixel interactions
- [x] Phase 4: Enforce unique agent nicknames and add avatar upload
- [x] Phase 5: Redesign room creation/sidebar with avatar selection and archive placement
- [x] Phase 6: Add named themes and generated twentieth-century pixel icon theme
- [x] Phase 7: Run full verification, open PRs, and prepare handoff

## Key Questions
1. Which requested fixes are already present on current `main` after the latest merges?
2. What seam can reproduce each reported bug deterministically before the fix?
3. How does Reasonix implement composition handling, composer transitions, and settings navigation without copying project-specific code?
4. Which OpenAI model should count as the cheapest selectable default based on the provider's returned model list and Socrates' compatibility rules?

## Decisions Made
- Keep one ticket per branch/PR, as required by `AGENTS.md` and the user.
- Never store or print the supplied API key; use existing Keychain credentials for live checks if needed.
- Treat the generated icon theme as the last ticket because project-bound image assets require a dedicated image-generation step.

## Errors Encountered
- `CONTEXT.md` is referenced by the debugging skill but absent in this worktree; read the relevant ADRs instead.
- GitHub issue bodies containing Markdown backticks were passed through a shell command string, so zsh performed command substitution and unintentionally ran the existing test/typecheck/build commands while creating #48-#52. All commands passed and no source files or secrets were changed. Issue bodies will be normalized without shell-sensitive quoting.
- The first #49 Tauri visual check could not start because port 1420 is already occupied by an existing Node/Vite process. The existing process was left untouched; the branch will be launched with a temporary Tauri config on port 1422.

## Status
**Complete** - #48-#52 and #58 are delivered as independent PRs; #57 conflict was resolved and reverified.

# Chat / Work reliability repair — 2026-11-05

Baseline: `4c1faa536a382b70ec5d43b19907bc10973d1f64` (latest origin/main, PR #137 merged).
Branch: `codex/fix-room-lifecycle-consistency`. Issue: https://github.com/Haosen-Zhang/Socrates/issues/138.
Scope: all applicable items in the attached repair specification; preserve user data and unrelated local edits.

- [x] Read instructions/architecture, inspect checkout and fetch current baseline.
- [x] Frontend: room-owned attachments/drafts/actions, history ordering/rewind barriers, unified navigation/composer and realtime Team consumption.
- [x] Runtime: queued pause/cancel/shutdown, Team settle/resume serialization, atomic plan edits, parent usage and native plan scope.
- [x] Context/events: frozen public context across Manager/discussion/reviewer/Worker; durable Team events and replay.
- [x] Compatibility/persistence: legacy room upgrade with history/identity/tasks, command rewind invalidation, Work defaults.
- [x] Integrate, run focused regressions, full tests, typecheck and desktop build.
- [x] Exercise browser user paths with isolated data and record current evidence/limitations.

Status: complete. Final host verification: 879 tests passed, zero failures/skips; typecheck/build passed. Browser: 28 checks passed, zero page exceptions. Acceptance: `doc/chat-work-reliability-repair-acceptance.md`. Native Tauri window/live Provider checks are not claimed.


---

# Cost-aware implementation — RUN_SCOPE=P00-P02

## Goal
Deliver provider invocation accounting, persistent prices, quotes, atomic budgets and resumable budget pauses through the existing Chat/Work production services and UI.

## Phases
- [x] P00: verify current baseline, shared invocation seam, provider contract and executable reuse experiments.
- [x] P01: exact money, frozen prices, provider-aware usage, immutable invocation ledger, configuration/export UI.
- [x] P02: bound quotes, atomic parent/child reservations, durable budget pause/increase/resume, task UI.
- [x] Verify migration preservation, controlled service integrations, UI interactions, full tests/typecheck/desktop build.

## Decisions and constraints
- User explicitly authorizes direct local implementation; do not stop at design approval.
- Keep all existing changes, room/history data and user files. Never use the normal application database for tests.
- No paid models, production secrets, uploads, pushes or releases.
- Current checkout e374dd3 includes persona/UI changes beyond main; retain this baseline rather than reset it to the prompt's older Alpha.1 commit.
- Cost ledger is authoritative and independent of history rollback; integers at fixed scale cross JSON as strings.
- Existing Native loop remains the only tool loop; gateway and every native sampling attempt share one broker.

## Errors encountered
- Initial combined reads exceeded output budget; re-read scoped specification sections.
- provider-retry.ts path in exploratory read does not exist; locate actual retry seam with rg.
- Regressions demonstrated before fixing: missing Native output cap, ignored stale quote, dropped raw billing warnings, strict-parent heuristic under-reservation, conflicting concurrent resume caps, CSV formula text and unsupported-modality text pricing. Owning tests now pass.
- Independent review fixed persisted user replan/ordinal recovery, monetary interrupted-package recovery, price validity at invocation time and cross-currency reconciliation. Browser diagnosis fixed a completed ledger panel closing during export; fixture test selector was corrected from Close to the existing Dismiss label.

## Status
Completed P00-P02. Final host gate: 971 tests pass, zero failures/skips, 22,148 assertions; typecheck and desktop build pass. Actual Chrome 20/20 checks pass; promptfoo evaluate 1/0. Durable report and evidence: implementation-progress.md and output/validation/cost-aware/summary.json. No paid/live Provider, native Tauri window, push or publication.

## Follow-up: sidecar startup repair
- [x] Reproduce checksum 23 failure using read-only metadata and an isolated source snapshot.
- [x] Freeze early 023, append 024, narrowly recognize the complete-023 variant without rewriting metadata or bypassing unknown drift.
- [x] Add both upgrade paths/data-preservation tests and a real entry-process handshake/HTTP bootstrap test.
- [x] Validate isolated source copy, then apply consistent-backup-protected local repair; 12 protected tables, 4 rooms and 8 messages unchanged.
- [x] Run full suite/typecheck/build; attempt isolated native Tauri observation; clean own services and record evidence/limitations.

Current result: 975 tests passed, zero failures/skips, 22,171 assertions; typecheck/build pass. Actual sidecar handshake/room APIs verified. Tauri process chain launched, but UI tooling cannot attach the unbundled binary; no rendered-window claim. Backup retained; no model or production credential use. Evidence: output/validation/sidecar-startup-fix/.

## Follow-up: Chat save / truncated planning / automatic output
- [x] Read-only diagnosis: old Chat speaker order empty; both reported Manager calls finished `length` at 1,024 tokens.
- [x] Reuse core room-aware collaboration defaults in the editable settings draft and expose validation reasons.
- [x] Follow user correction: remove token-limit choices from composer/resume; application-managed output with one larger, separately admitted planning repair.
- [x] Persist finish metadata and usage atomically; preserve explicit legacy caps, unknown-outcome boundaries and same-root checkpoints.
- [x] Verify actual SDK controlled SSE, monetary expansion pause/topup/resume, Chat UI save persistence and complete cost/Native browser flow.
- [x] Record 983/0 tests, 32/32 browser checks, typecheck/build and evidence in implementation-progress.md; stop disposable services.

Current result: output is managed by the application; users configure money. Existing rooms, history and cost facts are retained. Final evidence: output/validation/collaboration-regression/summary.json. No paid model, production database mutation, upload, push or publication in this follow-up.

## Follow-up: write preconditions / session approval (2026-11-07)
- [x] Read-only diagnosis: absent write target with three invented/empty-file hashes; approved calls failed at precondition validation.
- [x] Add explicit create-only null precondition and actionable hash-conflict output while retaining stale-write protections.
- [x] Align frontend/backend eligibility; wire persisted room/workspace/tool/generation/policy session grants into direct and team hosts after plan-scope checks.
- [x] Append migration 025; preserve old approval/grant records and keep unscoped historical grants inert.
- [x] Verify actual SDK correction, two approved writes after one session decision, exact plan-expansion confirmation, 990 passing tests, typecheck/build and 8 Chrome checks.
- [x] Record evidence in implementation-progress.md and stop own disposable fixture/Vite services.

## Follow-up: automatic pricing defaults (2026-11-07)
- [x] Read-only diagnosis: finished calls have usage but no price; UI incorrectly conflated this with uncertain outcomes.
- [x] Verify primary pricing/API docs; reuse PricingStore/Broker/quotes/ledger for automatic exact-endpoint official references and labelled unlisted/proxy presets.
- [x] Separate estimated/known money, preserve strict bounds and actual-outcome safeguards, and consume booked estimates in soft budgets.
- [x] Expose current-reference historical estimates without rewriting original facts; export separate fields and remove ordinary per-call bill forms.
- [x] Prefill provider model rates and apply one optional model override to future calls.
- [x] Validate 26-call isolated real-data copy with 15 protected tables unchanged; 998 tests, typecheck/build and 11 Chrome checks pass.
- [x] Record sources/limits/evidence, delete private test copy and stop disposable services. No paid model, production mutation, upload or push.

## Work interaction foundation — M00–M01 (2026-11-07)
- [x] Isolate on codex/multica-ux-m00-m01 from main b71a826, preserving original checkout/prompts/data.
- [x] Audit pinned/current Multica license/source, independent MIT candidates and existing Socrates runtime/cost seams.
- [x] Record domain authority, future WorkItem/Squad migration decisions and three component trees.
- [x] Build/render/keyboard-test Base UI in production member management, reusing existing identity/timeline/resize/dock/services.
- [x] Deliver Work navigation, real task projections/details, shared interactions and narrow drawers; fix observed integration issues.
- [x] Verify 1016/0 tests, typecheck/build/lint and 65/65 Chrome checks. Record reuse/bundle evidence and M02–M07 dependencies in implementation-progress.md. No push/publish/live model/user data mutation.

## Scrolling repair, then cost-aware P03–P04 (2026-11-07)
- [x] Reproduce long Work result overflow, fix root flex constraint, pass 17 actual browser checks and all 1016 tests/types/build/lint.
- [x] P03: freeze and persist verification plans/snapshots/evidence; run checks through existing tool permission/approval/leases; gate package dependencies; expose results and recovery UI.
- [x] P03: validate false success, zero tests, stale artifact/contract change, permissions/timeouts/restart, single/team/integration; record stage evidence.
- [ ] P04: deterministic candidate/features/whole-workflow pricing and presets, persistent LangGraph flow through existing hosts, bounded evidence-based retry/escalation, UI and compatibility.
- [ ] Complete all gates, real UI checks and progress/reuse documentation; preserve user data and do not push automatically.
