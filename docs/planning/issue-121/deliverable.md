# Ticket #121 delivery

Implemented catalog-backed context-window resolution, Agent form prefill with
explicit override semantics, persisted provenance snapshots, migration of
legacy values, and unavailable handling without guessed runtime limits.

## Verification

- `bun run lint`: passed, 270 files.
- `bun test`: passed, 516 tests; 2 platform-dependent tests skipped.
- `bun run typecheck`: passed.
- `bun run --cwd apps/desktop build`: passed with existing Tauri import and
  bundle-size warnings.

Automatic semantic summary compaction remains intentionally deferred to
CMP-001 after HIST-001, HIST-002, and MEM-002, as required by ADR-0008.
