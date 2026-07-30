# Notes: UI-001 Room Creation

## Baseline

- Base commit: `b2b4161`.
- Ticket: https://github.com/Haosen-Zhang/Socrates/issues/95
- Branch: `codex/95-ui001-room-creation`
- Worktree: `/private/tmp/socrates-95-ui001`

## Confirmed regression evidence

- The affected Agent snapshot has no numeric `contextWindowTokens`.
- `SingleAgentRunner` falls back to 4,096 tokens.
- The full native tool/system schema currently costs 5,061 conservative tokens.
- Output reserve plus schema leaves a one-token conversation budget.
- The two observed runs failed before Provider sampling with
  `context_current_unit_exceeds_budget`.

## Findings

- New rooms now use the Sessions API only. Legacy `/rooms` data remains readable
  for backward compatibility but is not offered as a creation type.
- Workspace migration 013 records `external | managed` ownership and one
  `ownerSessionId` for managed roots.
- Managed room deletion is fail-closed until the caller chooses `keep` or
  `delete`; existing project directories are never recursively removed.
- The primary Agent is selected once from the first chosen member and sent as an
  explicit field. Reordering members does not recompute it.
- Numeric context limits remain authoritative. Only missing/unknown metadata
  uses the 32K compatibility fallback.
- Agent errors render above the composer, which remains visible at the bottom of
  the conversation.
