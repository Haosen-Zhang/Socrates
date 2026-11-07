# ADR 0009: Model invocation, monetary ledger and budget authority

Date: 2026-11-06. Status: implemented locally for RUN_SCOPE=P00-P02.

## Context

The e374dd3 baseline already has Native's tool loop and observable retries, durable room commands, Manager/Worker packages, reviewers, leases and token statistics. Token costs are null; wrapping only top-level runs would miss Native samples, Manager repairs and reviews. Message rewind must not manufacture provider refunds.

## Decision

- `ModelInvocationBroker` is the only production monetary admission boundary. Gateway replies/discussions/Manager/reviewer calls and every Native sampling attempt enter it. SDK retries remain disabled; Native retains ownership of its existing tool loop and explicit retries.
- Core money is a fixed scale of 12 decimal places, using integer strings across JSON and bigint for arithmetic. Existing token APIs remain backward compatible; monetary summaries have a separate projection.
- Migration 023 introduces immutable prices, invocations, adjustments, budgets, reservations and quotes; it is frozen to its first applied checksum. Append-only 024 adds actions, invoice totals and legacy observation capture. The known complete-023 interim variant is recognized only with its actual schema; arbitrary drift remains rejected and applied checksums are never rewritten. Accounting has no cascading foreign keys to rooms, messages, runs or rollback projections. No prompt, key, raw reasoning or file body enters the ledger. Old token records remain historical unknown costs, never repriced retrospectively.
- Prices map an exact connection/model/endpoint/protocol/tier. User-confirmed connection prices take precedence over official and verified catalog data. Only tested token adapters price text; missing cache quantities, unsupported lifetimes, service tiers and modalities remain visibly incomplete. Each request freezes its own snapshot. Budgeted tasks pause on an incompatible/new price and explicitly re-quote on resume.
- Budget admission uses one SQLite immediate transaction over all ancestor accounts. Reserve, possibly-sent, settled, released-unsent and unknown are distinct. Unknown exposure excludes the already settled known subtotal and is never refunded by a timer. A known charge above its reservation is recorded in full and pauses later requests.
- Strict mode needs a verified official model context maximum with catalog provenance plus the SDK's executable output cap and an applicable tariff. A user context-window override or character estimate is insufficient. Soft mode uses a disclosed byte heuristic and can exceed its estimate. Tracking-only is an explicit option and does not enforce spend thresholds. These modes control new Socrates requests; they cannot undo remote computation or cap other clients' consumption.
- Output limits are application policy, not a decision required in the composer or budget-resume UI. The broker starts automatic requests with 8,192 tokens and permits a 32,768 ceiling. Planning may spend its one repair attempt on a larger allowance after a known `length` finish; the broker admits and prices that physical request separately. Explicit legacy API caps remain binding, and unknown outcomes never trigger this expansion. The plan-finish event and completed usage are committed together so a budget pause/restart does not rebill the completed first attempt.
- Price entry is also optional in normal use. Exact official connections use versioned bundled reference rules; unlisted models/proxies use an explicitly estimated preset, below user-confirmed/official/catalog precedence. Known and estimated consumption stay separate, while both reduce soft-budget availability. Unverified presets cannot prove strict bounds. Historical unpriced usage can expose a separate current-reference estimate without changing original accounting rows or releasing their old unresolved reservations. See [automatic model prices](../../doc/automatic-model-pricing.md).
- Workspace queue/lease acquisition precedes per-request monetary reservation; a budget pause leaves the Native execution and releases the lease. Resume uses the same command/root task and durable tool facts. Completed packages, messages and side effects are not reissued. Unknown remote outcomes require reconciliation and existing tool recovery safeguards remain independent.
- Unpriced external MCP tools are unavailable in strict/soft tasks until a tested tool tariff exists; quotes disclose the coverage. No hidden paid summarization is used to report a budget pause.
- UI quote results are room/revision bound. An uncertain HTTP submission retains its original request ID and original quote envelope even if the draft gets a newer quote. Increase/resume/reconciliation actions use persistent request IDs and budget revisions.

## Reuse and alternatives

Reuse official AI SDK protocols, models.dev data, existing Zod, SQLite and OpenTelemetry. LangGraph owns only the explicit compatibility workflow in this run; its durable Bun saver passed a process-restart experiment. It is not a second owner of existing team scheduling. The official native SQLite saver failed to build on the current host; the failure and narrow adapter are documented in [reuse decisions](../../doc/cost-aware-reuse.md). Promptfoo executes full controlled Socrates tasks in a separate development package. No Python proxy, Redis, cloud database, exporter or account is needed.

Stacking an SDK Agent loop around Native, keeping mutable totals in UI/checkpoints, and cascading ledger deletion with room history were rejected because they would duplicate execution or cost authority.

## Retention and limits

Room rewind/deletion retains minimal accounting identity/usage/tariff facts. There is no automatic accounting purge or provider-bill download; invoice reconciliation is an explicit local user-confirmed fact. Permanent anonymization/purge needs a separate privacy operation. No live Provider call or native Tauri interaction is claimed by fixture/browser evidence. Adaptive routing, verified artifact delivery, project memory and Arena remain P03-P08.

Run commands, current test counts, migration evidence and remaining limitations are in [implementation-progress.md](../../implementation-progress.md).
