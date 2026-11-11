# M04–M05 implementation and acceptance

Scope: Agent lifecycle, run timeline, structured routing, bounded handoff and local Inbox. Base `d87b365` (PR #153 merged), branch `codex/multica-ux-m04-m05`, issue #154. Current worktree already contains untracked earlier browser artifacts; they remain untouched.

## Authority and scope

AgentDefinition is configuration, not a process. Availability derives from provider/runtime/credential/tool evidence; workload derives from current runs/packages/queues. A failed historical run never changes provider reachability. WorkItem ownership remains separate from a temporary message target and each frozen execution identity.

The existing EventStore/ExecutionEventStore, RoomCommandService, TeamRunner, Native Runtime, WorkspaceLeaseManager, Approval and cost/verification services remain authoritative. New records may persist probe evidence, user instructions and deduplication; they must not copy tool results or invent a parallel runtime. Agent text and raw `@name` do not schedule work. Native has no reliable acknowledged in-run injection; user options are queue or confirmed stop then restart.

Reuse/license audit: [reuse-decisions.md](reuse-decisions.md), including the actual reference checkout and pinned-path discrepancy. No Multica code/assets or new dependency is incorporated.

## Validation

Pending implementation. Evidence and exact commands will be added after running each stage. Tests use temporary SQLite/workspaces and controlled providers; no private content or paid provider calls.

### M04 evidence

Local implementation `995cf81`: pure core projections + migration 037 probe evidence; service-level Native/package/planning/discussion run union; shared roster detail; 30-day cost/statistics; paged grouped timeline, durable event invalidation, canonical recorded write diffs and current verification/Git evidence (clearly separated).

- 81 targeted tests, 0 failures: actual temporary SQLite migration/reopen, expired/stale provider evidence, capability change, unavailable+idle, workspace queue/approval/pause/retries, team attempts, stable event cursors, real Native write/diff and rewind/no-ghost records. Billing retained after rewind.
- Root typecheck and desktop build passed. Existing Vite chunk-size/dynamic-import warnings remain.
- Chrome checks 8/8: roster→detail, completed run leaves idle, durable timeline, no-Git honesty, unavailable provider independent of idle, re-enable remains unknown without probe, narrow drawer within viewport, zero renderer errors/external browser requests. Screenshot visually inspected at 650×600. Evidence currently in `output/playwright/multica-m04-m05` (final subset copied into tracked docs after both stages).

Provider evidence certifies only a recent models-endpoint probe, never inference or all model access. Historical diffs exist only where canonical tool output contains them; missing evidence remains unavailable. Existing retention bounds are disclosed. No native installer/OS IME/real API verification performed.
