# Agent Workspace Implementation Progress

## Goal

Implement the approved Agent Workspace plan in reversible, tested milestones without changing the agreed architecture or weakening workspace, approval, and runtime boundaries.

## Baseline

- Starting commit: `9f7955d5704918e9e8375b4b89c31a7d44a31a2f`
- Implementation branch: `codex/agent-workspace-m3-chat-agent` (stacked on the verified Milestone 2 commit)
- Approved specifications:
  - `doc/agent-workspace-master-plan.md`
  - `doc/agent-workspace-tasklist.md`
  - `doc/ui-interaction-bug-audit.md`

## Milestones

- [x] Milestone 0: Capture build/test/lint/typecheck/smoke baseline and add minimal regression seams.
- [x] Milestone 1: Complete UI-001 through UI-004 (micro icons, hover entry, global particles, visual checks).
- [x] Milestone 2: Workspace and Agent Core foundation.
- [ ] Milestone 3: Chat, Single Agent, attachments, images, drag/drop, and `@path` (Single Agent and attachment vertical slice implemented; legacy Chat migration and final visual/smoke checks remain).
- [ ] Milestone 4: MCP settings, lifecycle, discovery, registry, permissions, and recovery.
- [ ] Milestone 5: Multi-Agent discussion, plan approval, and designated execution.
- [ ] Milestone 6: Per-Agent usage/reasoning, resizable composer, and recovery UX.
- [ ] Final verification, code review, commit, and handoff.

## Test Seams

- Core: public pure reducers and policy evaluators.
- Sidecar: authenticated HTTP/event APIs and runtime/tool adapter boundaries.
- Desktop: exported interaction predicates/state reducers plus rendered user behavior.
- External runtimes/MCP/providers: deterministic transcript/fake-server fixtures; real credentials are manual-only and require explicit authorization.

## Decisions

- Preserve the approved hybrid architecture: Socrates-owned product state and journal, Native AI SDK for Chat/read-only flows, pinned Codex app-server for the first mature write/shell runtime.
- Keep one milestone branch/commit boundary at a time. Milestone 1 is the current branch; subsequent milestones require their own branch after verification.
- Do not overwrite the existing root `task_plan.md` and `notes.md`, which belong to prior completed work.

## Errors Encountered

- Initial branch creation inside the managed filesystem could not lock the parent repository ref. Retried through the approved Git escalation and created the branch successfully.
- `bun run lint` exits 1 with `error: Script not found "lint"`; this is the approved-plan baseline gap, not a regression. ENG-001 owns the fix.
- Sandboxed sidecar startup reports `EADDRINUSE` for port 0. Re-running the same isolated-data command with local network permission produced a valid handshake and health response; this matches the documented sandbox limitation.
- The screenshot helper could not obtain macOS Screen Recording permission. Used a Vite/Playwright visual fixture and Chrome 1x/2x device-scale screenshots instead; real Tauri window appearance remains a user visual check.
- The first hot reload of the visual matrix exposed a missing JSX closing tag. Fixed it before final visual capture; the final fixture loaded without application errors (favicon 404 only).

## Status

**Milestone 3 in progress** — three-mode creation UI, Workspace-bound Single Agent sessions, Native AI SDK read-only tool loop, experimental pinned Codex write runtime, durable approval cards, structured messages, safe attachment storage, picker/drag/paste, image preview and bounded `@path` refs are implemented. Current checkpoint gate: 165 tests / 0 failures / 541 assertions; typecheck, Biome lint, desktop production build and Rust `cargo check` pass. Legacy Room Chat still needs migration to Session/event replay, attachment GC remains open, and real-provider/Codex credential smoke is intentionally not run without explicit authorization.
