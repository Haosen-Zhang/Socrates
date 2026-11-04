# Single-agent tool recovery implementation plan

> **For agentic workers:** Use superpowers:executing-plans task-by-task.

**Goal:** Finish Phase 4: durable tool intent, distinct attempts, conservative retry and visible unknown outcomes.

**Architecture:** Reuse tool_calls as logical operations and runtime_events as the execution journal. Add tool_attempts with atomic journal/projection writes. Adapt DeepSeek Harness's started-versus-result distinction and recovery guidance to SQLite and existing HistoryStore.

**Tech Stack:** TypeScript, Bun, SQLite, existing AI SDK and HistoryStore.

**Spec:** Supplied reliability specification sections 8–15; docs/07-execution-event-authority.md. Current direction prioritizes small single-agent deliveries.

## Global Constraints

- Preserve Native runtime, approvals, workspace security and history authority.
- No new framework or dependencies; no multi-agent orchestration expansion.
- Incremental PR depends on open Phase 3 PR #132.
- Never automatically retry ambiguous mutations; preserve completed results.
- Phases 5–8 remain separate follow-up slices.

## Review Focus

- Failed pre-tool checkpoint must prevent effects.
- Failed result persistence must preserve uncertainty, not imply failure.
- Concurrent duplicate calls must execute once.
- Restart must repair paired model history with explicit uncertainty.
- Session allow policy must not bypass fresh approval for unknown mutations.

### Task 1: Durable tool operations and attempts

**Files:** tools/execution-journal.ts, tools/executor.ts and tests; migration 018; core tool contracts.
**Interfaces:** ToolContext adds optional stepId; ToolExecutor retains invoke/resumeApproved. Journal owns atomic execution facts and projections.

- [ ] Add SQLite tests for checkpoint/result failure, duplicate execution, safe transient retry and mutation no-retry.
- [ ] Run executor tests; expect new assertions to fail.
- [ ] Implement migration, journal and executor. Maximum 3 attempts for classified transient read/idempotent errors; domain errors get one attempt.
- [ ] Run focused tests; expect pass. Commit.

### Task 2: Native runtime and restart integration

**Files:** runtime contracts, RuntimeManager, NativeAgentRuntime, SingleAgentRunner, index and tests.
**Interfaces:** Runtime start receives execution {runId,turnId}. Native binds Step before dispatch. Recovery classifies missing results without executing bodies. HistoryStore projects paired tool history before another sample.

- [ ] Add restart, runtime identity, history repair and fresh approval regression tests.
- [ ] Run affected tests; expect new assertions to fail.
- [ ] Connect journal, scope, startup recovery and history repair; stop sampling after persistence failure.
- [ ] Run affected tests; expect pass. Commit.

### Task 3: Documentation and delivery

**Files:** execution authority docs, ADR, third-party notice.
**Interfaces:** Document pinned DeepSeek source, MIT reuse and remaining phases.

- [ ] Update docs and attribution.
- [ ] Run tests, lint, typecheck, desktop build and diff check; expect pass.
- [ ] One fresh-context whole-branch review; fix important defects with regression tests.
- [ ] Push and create incremental PR; report scope and remaining phases.
