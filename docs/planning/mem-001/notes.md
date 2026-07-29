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
- `bun test`: 380 passed, 0 failed before final review.
- `bun run typecheck`: pass.
- `bun run --cwd apps/desktop build`: pass with the existing Vite warnings.
- Changed-file Biome lint: 23 files checked, no findings.
- Repository-wide Biome lint: seven existing findings, all outside the MEM-001
  diff.
