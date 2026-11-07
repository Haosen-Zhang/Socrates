# Implementation evidence

- User acceptance source: attached Pasted text.txt, all 22 criteria + engineering verification.
- Existing rooms.ts is legacy Chat; sessionRoutes hard-codes cowork/workspace creation.
- Existing native production factory reads global agents rather than session snapshot.
- Existing core resolveRoomRuntime already respects explicit strategy for Work; UI entry needs reconnection.
- Existing durable execution events, supervisor and tool journal retained.
- No dependencies/framework migration planned; avoid duplicating tool execution paths.


Final evidence: doc/chat-work-collaboration-acceptance.md; /tmp/socrates-tests-delivery.log (828 pass, no skips/failures); output/playwright/{ui-checks,team-checks}.json. Shared Native tools, persisted facts, review semantics and original source history retained. No new production dependencies.

---

## Prior development record (preserved)

# Notes: Socrates proxy and product polish

## Sources

### Socrates repository
- Local workspace: `/Users/haosen/Developer/Socrates/.claude/worktrees/skills-repo-setup-3cd946`
- `origin/main` currently points to merge commit `55c6a2e`, which includes PR #47.
- The main checkout is owned by `/Users/haosen/Developer/Socrates`; this worktree must branch directly from `origin/main`.
- Relevant ADR: the sidecar is a Bun process spawned by Tauri and owns outbound provider requests, so macOS proxy discovery belongs in `apps/sidecar`.

### DeepSeek Reasonix
- URL: https://github.com/esengine/DeepSeek-Reasonix
- Relevant composer, transition, and settings patterns will be recorded after source inspection.

### OpenAI model pricing
- Official model catalog: https://developers.openai.com/api/docs/models
- Official GPT-5 page lists GPT-5 nano at $0.05 input per million tokens and as the nano tier.
- Official GPT-4o mini page lists $0.15 input and $0.60 output per million tokens.
- Official GPT-5.4 nano page lists $0.20 input and $1.25 output per million tokens and calls it the cheapest GPT-5.4-class model.
- Socrates therefore uses an explicit current low-cost alias ordering, filters out embedding/audio/image/moderation models, and falls back to tier hints such as nano, mini, and luna for future returned IDs.

## Existing diagnosis supplied by the previous work session
- macOS system proxy is configured at `127.0.0.1:6789`.
- Direct OpenAI traffic timed out, while explicit HTTP and SOCKS proxy probes returned promptly.
- Socrates auto mode timed out because the sidecar only read proxy environment variables; Tauri did not pass macOS system proxy settings.
- Explicit custom HTTP proxy mode succeeded, so TUN mode was not required for the reproduced case.

## Synthesized Findings

### Ticket map
- #48: macOS auto proxy discovery.
- #49: provider type/model selectors and cheapest OpenAI default.
- #50: IME-safe composer and fluid pixel interactions.
- #51: unique agent nicknames and custom avatar upload.
- #52: pixel room sidebar and avatar-based creation modal.
- #37: named themes and generated pixel icon theme.

### Security
- User-provided API keys must remain outside the repository and tool output.

### #48 macOS auto proxy
- Red-capable command: `bun test apps/sidecar/src/net.test.ts`; before the fix it returned `undefined` instead of `http://127.0.0.1:6789` when proxy env was absent and a representative `scutil --proxy` payload was supplied.
- Root cause: `resolveProxyFor` only considered HTTP proxy environment variables. The Tauri-spawned sidecar did not inherit those variables.
- Fix: preserve environment precedence, then read `/usr/sbin/scutil --proxy` on Darwin, parse enabled HTTPS/HTTP/SOCKS records, and cache the system query for five seconds.
- Live macOS smoke test with proxy env removed resolved `http://127.0.0.1:6789`; an unauthenticated OpenAI models request returned HTTP 401 within ten seconds instead of timing out.

### #49 provider selectors
- Red-capable command: `bun test packages/core/src/provider.test.ts apps/sidecar/src/providers.test.ts`.
- Before the fix it showed three exact failures: provider PUT kept `openai_compatible`, draft model discovery returned 404, and the low-cost selector export did not exist.
- Root cause of the inert type control: the edit form explicitly set `disabled={editingId !== null}` and the provider PUT route ignored type.
- Root cause of the missing default-model picker: model loading existed for provider cards and Agent editing, but the provider modal always rendered a text input and had no draft-credential discovery endpoint.

# Reliability repair notes — 2026-11-05

- Current remote main is the exact supplied review baseline 4c1faa536a382b70ec5d43b19907bc10973d1f64; prior PR #137 is merged. No later fixes to reuse.
- Existing `.reasonix/desktop-topic-auto-title-meta.json`, `.playwright-cli/` and untracked prior preview artifacts are user/local material and remain untouched.
- Initial git fetch lacked write access to .git/FETCH_HEAD; retried with scoped host approval and succeeded.
- Test fixtures must use temporary workspaces and test databases; production stores/runtime are the verification targets.

- Final repair validation: host `bun test` 879 pass / 0 fail / 0 skip / 3303 assertions; typecheck and desktop build passed. Four macOS isolation tests ran on host, superseding nested-environment skips.
- Final Chrome UI: 28 passing checks, zero exceptions. Production Native runtime and history used with controlled external model stream. Live Provider/native Tauri window not exercised.
- Cross-review added fixes for continued-run and Team-child rewind ownership, cached removed run lookup, stale Continue UI, frozen tool capability during edited approval, and recoverable reviewer failure stream finality.
- Preview/test harness issues resolved: missing MCP server endpoint, missing file-context resolver, HMR duplicate module state, asynchronous UI waits and confirmation clicks. No user data involved.


---

# Cost-aware implementation notes

## Baseline
- Current branch: codex/readme-persona-studio, e374dd3; prompt reference: 8f5fa212 (Alpha.1).
- Preserve pre-existing .reasonix metadata modification and all untracked prompt/Playwright artifacts.
- Architecture is three TypeScript workspaces, Bun/Hono/SQLite sidecar, React/Zustand frontend.
- Native runtime already disables SDK retries and tracks ProviderAttempts. Gateway disables internal retries too.
- UsageCollector already aggregates failed/budget-stopped work package attempts, but cost/currency remain null.
- LangGraph prototype is not a production orchestration owner; adaptive routing remains out of this run's scope.

## Sources
- Socrates_Alpha1_CostAware_Implementation_Prompt.md: master, foundation, P00-P02, T01/T02, reuse references.
- AGENTS.md; doc/architecture.md; doc/native-runtime-and-langgraph-roadmap.md.

## Shared contracts
core cost.ts owns Money/PriceSnapshot/InvocationIdentity/CostSummary/BudgetSummary. Price keys use canonical gateway modelProtocol. Root owns broker/orchestration/routes/quotes; billing worker owned 023/ledger/pricing, UI worker owns frontend, reuse worker owns gateway + reproducible fixture/spikes.

## Implementation evidence
- Baseline local tests: 881 pass, 4 macOS nested-sandbox skips, 0 fail; baseline typecheck passes.
- Real controlled team: Manager + 3 Native samples + 2 reviews, six priced invocations = USD 0.000900 under synthetic rates. Builtin write_file remains one operation after monetary pause/resume; leases released.
- Direct Chat and discussion+summary share broker, continuation retains user message/root. Unknown Native usage survives DB reopening, no automatic replay after topup.
- Real Chrome initial 12 checks passed; output/playwright/cost-aware holds screenshots and JSON evidence. No paid Provider/external browser request.
- Independent review fixed strict parent under-reservation, per-request price validity, persisted user replan boundary, monetary interrupted-package recovery, cross-currency invoice escape and uncertain submit identity.
- Final evidence belongs to implementation-progress.md; provisional counts above are not substituted for the final full gates.

## Follow-up startup failure
- Root cause reproduced: applied early 023 checksum c31ffcef versus edited complete checksum 04bbe3e3; local schema lacked the later tables/column.
- Original 023 frozen, additions in 024; known complete variant recognized only with its schema, no metadata overwrite or arbitrary checksum bypass.
- Local database upgraded after consistent backup; 12 protected tables unchanged (4 sessions, 8 messages), with no history-file rewrite or credential/model access.
- Real child-process startup regression verifies handshake and authenticated room/cost bootstrap using an early-023 temporary database.
- Current verification: 975/0/0 tests, typecheck/build green. Native development process ran, but CUA cannot target the unbundled binary. Evidence: output/validation/sidecar-startup-fix/.

## Follow-up Chat settings / automatic output
- Chat default discussion order was empty; opening the editor now resolves defaults against actual members while retaining explicit subsets/order. Save validation is visible.
- Actual reported Manager calls had `length` with output 1024 / reasoning 1024 and 1008, yielding 0 and 37 content characters. Fixed the low default and identical-cap repair behavior.
- User explicitly wants no token-limit decisions. Composer/resume show monetary controls only. Automatic planning can expand 8192→32768 within its one repair and the broker's per-request monetary admission; legacy explicit caps stay binding. Finished-turn metadata and usage are atomic and restart-safe.
- Actual SDK controlled SSE proves automatic expansion, budget pause, topup and same-root resume without repeating the completed first call. No execution precedes plan approval.
- Final: 983 tests / 0 failures, typecheck/build pass, 32 Chrome checks pass with zero renderer/external requests. Evidence: output/validation/collaboration-regression/. Actual data was read only; no paid call, upload or push.

## Write/session-permission repair (2026-11-07)
- Actual approved writes failed with WORKSPACE_FILE_CHANGED because the target was absent and the model supplied invented / empty-file preimage hashes. Null now means atomic create-only; real hash conflicts remain guarded with actionable feedback.
- UI showed session permission for high-risk writers while the manager rejected it; saved grants had no runtime consumer. Shared eligibility now permits scoped non-destructive built-in writers and excludes fresh/destructive/command/scope-expansion requests.
- Migration 025 appends request room/generation scope; grants bind workspace/tool/generation/risk/policy/expiry and are consumed only after exact plan-scope checks. Legacy unscoped grants are retained without expanding access.
- Actual SDK and Chrome controlled fixtures verify corrected writes, one session decision, an automatic second write, and fresh confirmation for the third plan expansion.
- Final: 990/0 tests, 22,258 assertions, typecheck/build and 8/8 browser checks. Real data read only; no model charge, upload or push. Evidence: output/validation/write-permission/.

## Automatic pricing defaults (2026-11-07)
- Finished usage was recorded but prices were unknown; generic “awaiting reconciliation” and invoice forms made manual entry look mandatory.
- Add automatic exact-endpoint official references for configured OpenAI/DeepSeek models and explicitly estimated unknown/proxy presets. No per-message online price call; no universal price endpoint assumed. Rates are versioned, source-linked and user-overridable once per model.
- Known and estimated totals remain separate. Soft budgets consume booked estimates; strict admission rejects unverified generic presets. Frozen invocation prices remain immutable; current-reference historical views do not settle old uncertainty or rewrite facts.
- Real-data isolated copy: 26/26 calls estimated, all 15 protected table hashes unchanged. Actual database read only; private copy cleaned after derived evidence capture.
- Final: 998/0 tests, 22,294 assertions, typecheck/build and 11 Chrome checks. Sources/limits: doc/automatic-model-pricing.md. Evidence: output/validation/automatic-pricing/. No paid inference, credential use, upload or push.
