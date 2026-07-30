# MEM-001 Notes

## Confirmed root cause

- Desktop reloads durable messages for display, but posts only the current prompt.
- SingleAgentRunner persists the current user message but never loads Thread history.
- Native AI SDK initializes provider messages from one current user prompt.
- Tool calls/results live only inside the current runtime loop and are not product conversation records.
- Successful final assistant text is already persisted.
- Root Agent is selected by member position instead of an explicit persisted primary Agent.

## Required seams

- Core conversation-memory contracts
- Additive SQLite migration
- ConversationMemoryStore
- Context builder/token budget
- SingleAgentRunner preparation/finalization
- Runtime typed-message input
- Native AI SDK ModelMessage conversion
- Desktop stable client turn key

## Verification log

- Focused migration/store/context/runtime tests: pass.
- `bun test`: 394 passed, 0 failed after review fixes.
- `bun run typecheck`: pass.
- `bun run --cwd apps/desktop build`: pass with the existing Vite warnings.
- Changed-file Biome lint: no findings.
- Repository-wide Biome lint: seven existing findings, all outside the MEM-001
  diff.

## Two-axis review fixes

- Updated `doc/architecture.md` with migration 011 and the authoritative local
  memory flow.
- Changed bounded history reads to keep the newest page and diagnose earlier
  omitted sequences.
- Added explicit context-window capability data with a conservative fallback;
  oversized current work now fails before provider sampling.
- Reconstructs parallel tool calls/results and intermediate assistant text into
  provider-valid ordering.
- Removed read-time `primaryAgentId` fallback and rejects ambiguous creation.
- Conflicting message idempotency payloads now fail closed.
- Local text attachments and workspace references are resolved under
  `WorkspacePathPolicy`, snapshot-checked, and budgeted before provider sampling.
- Orphaned tool calls/results caused by paging or cancellation stay in the audit
  history but are excluded from provider context.
- Agent setup exposes optional context-window capability data; unknown values
  keep the conservative runtime fallback.
- Co-work creation sends an explicit `primaryAgentId` selected in the room form
  rather than deriving the execution identity from array position.
- Session creation now rejects an omitted `primaryAgentId` at both protocol and
  store boundaries.
- `@path` content is captured in the local content-addressed attachment store;
  refreshing or editing the live path cannot mutate old conversation context.
- Final assistant output and terminal projections share one SQLite transaction.
- Native cancellation aborts the provider signal and keeps already visible
  partial text with a non-completed terminal status.
- Tool exchanges are paired by Run and call ID, and runtime system/tool-schema
  overhead participates in the authoritative model context budget.
