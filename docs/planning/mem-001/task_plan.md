# MEM-001 Implementation Plan

## Goal

Persist product-authoritative same-Room/Thread Single-Agent memory in local Socrates SQLite and rebuild provider context from it on every turn.

## Ticket

- GitHub: https://github.com/Haosen-Zhang/Socrates/issues/81
- Branch: `codex/mem-001-thread-memory`
- Worktree: `/private/tmp/socrates-mem-001`
- Baseline: `origin/main@883020e`

## Phases

- [x] Phase 1: Create Ticket, sync main, and create isolated worktree/branch
- [x] Phase 2: Reconfirm current schema/runtime seams and write failing focused tests
- [x] Phase 3: Add additive migration and ConversationMemoryStore
- [x] Phase 4: Integrate stable primary Agent, Thread/Turn identity, and idempotent run preparation
- [x] Phase 5: Feed durable typed history and tool results into Native AI SDK
- [x] Phase 6: Add token-budget context policy and truncation diagnostics
- [x] Phase 7: Run targeted tests, typecheck, full tests, desktop build, and migration checks
- [ ] Phase 8: Review diff, update implementation report, commit, push, and open PR

## Guardrails

- No changes on `main`.
- No cross-room/long-term memory, embeddings, RAG, or user profiling.
- No LangGraph production registration or checkpointer work.
- No Codex CLI or access to `~/.codex`/`CODEX_HOME`.
- No hidden chain-of-thought persistence.
- SQLite message history is authoritative; UI/runtime state is not.
- Do not split a tool call from its tool result during context trimming.

## Decisions

- Keep `sessions` as the physical Room foreign key for compatibility.
- Use additive migrations and preserve all existing message rows.
- Assign deterministic per-Thread sequence numbers and idempotency keys.
- Persist successful final assistant output and structured tool call/result events; cancellation creates no fake final message.

## Baseline differences

- Repository-wide `bun run lint` still reports seven pre-existing unused
  import/variable errors in files untouched by MEM-001.
- Biome passes all 23 TypeScript/TSX files changed by this Ticket.
- The existing Vite dynamic-import and chunk-size warnings remain unchanged.

## Status

Phase 8: review, commit, push, and PR creation.
