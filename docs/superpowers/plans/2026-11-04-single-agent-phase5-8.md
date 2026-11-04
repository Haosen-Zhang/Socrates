# Single-Agent Phases 5–8 Implementation Plan

> **For agentic workers:** Use Superpowers test-driven-development and dispatching-parallel-agents for independent modules; the coordinating agent integrates and verifies the complete branch with one fresh final review.

**Goal:** Complete filesystem reliability, Tool Contract v2, execution policies and fault-injection acceptance in one PR, reaching the supplied single-agent milestone through Phase 8.

**Architecture:** Preserve Bun/SQLite execution authority and HistoryStore public history. Extend existing workspace policies, ToolExecutor and Native runtime; reuse compatible DeepSeek Harness source with pinned attribution. No new orchestration framework or multi-agent feature work.

**Tech Stack:** TypeScript, Bun, SQLite, Node filesystem/process APIs, existing native filesystem bindings and AI SDK.

**Spec:** User-supplied reliability specification `/Users/haosen/.codex/attachments/e41bbeb7-b06a-46bd-a720-4587e1845914/pasted-text.txt`, sections 16–30 and 34; `docs/07-execution-event-authority.md`. Latest user explicitly authorizes implementation through Phase 8 and one PR without intermediate phase handoffs.

## Global Constraints

- Preserve workspace containment, symlink/hardlink/secret protections and exact host-owned approvals.
- Never blindly replay unknown mutations. External effects and SQLite are separate transactions.
- Core remains zero IO. Native workspace semantics remain Native; MCP stays an external adapter.
- Commands use executable plus argv, shell=false, controlled environment, policy and process-tree cancellation.
- Reference source: DeepSeek Harness commit `8bd073392eef6f54e921a093b95076248eb08cbb`; retain MIT notice for adapted source.
- Branch began at main `ee9d73d`; includes the merged Phase 3/4 prerequisite branch `3510e6e`. PR targets main.

## Review Focus

- Crash or concurrent edit during staging must not truncate or silently overwrite the target.
- Nested input and canonical output validation must fail before invalid results become durable success.
- Deadline/cancellation must stop subprocess trees and cannot permit a following sample while an unresolved mutation is still running.
- Spill references must be scoped, bounded, durable and inaccessible through arbitrary filesystem paths.
- Restart/denial/retry must preserve exact approval and valid model history, including legacy records.

### Task 1: Phase 5 filesystem safety

**Files:** workspace/path-policy.ts, workspace/native-fs.ts, focused workspace mutation helpers and tests. Coordinator owns tools/workspace-write-builtins.ts integration.
**Interfaces:** Extend readText with full-content sha256/path. Extend writeText(path, content, options?) with expectedSha256, operationId, signal; return old/new hashes and bounded diff. Expose conservative recovery of staged operations using durable evidence without replaying bodies.

- [x] Add failing atomic overwrite/interruption, stale hash, symlink/hardlink, staging and recovery tests; run `bun test apps/sidecar/src/workspace` and confirm intended failures.
- [x] Adapt compatible DeepSeek fs-local atomic publication logic to existing secured descriptors; preserve permissions, verify target before publication, and retain recoverable staging evidence.
- [x] Run workspace tests; expect pass. Integrate expectedSha256 and structured write output, then commit Phase 5.

### Task 2: Phase 6 recursive contracts and read coverage

**Files:** packages/core/src/tools.ts and schema tests; tools/native-tool-contracts.ts; tools/read-only-builtins.ts and tests. Coordinator owns executor validation and write-tool registration.
**Interfaces:** Recursive JsonSchema with descriptions/enums/arrays/objects/constraints/examples; ToolDefinition.outputSchema, timeoutMs and renderOutput. `applyNativeToolContracts(ToolDefinition[]): ToolDefinition[]` supplies accurate write-tool contracts. read/search return canonical fields and explicit bounded coverage.

- [x] Write failing nested arrays/objects/enums/constraints tests plus search traversal/file truncation coverage tests; confirm intended failures.
- [x] Implement the shared vocabulary and truthful descriptions/output schemas for every Native tool, including real spreadsheet nesting.
- [x] Run core tools and read-only tool tests; expect pass. Integrate canonical output validation before authoritative results; commit Phase 6.

### Task 3: Phase 7 structured command verification

**Files:** tools/workspace-command-runner.ts, tools/command-tools.ts and tests. Coordinator replaces legacy run_shell registration and connects generic deadline/output policies.
**Interfaces:** `createCommandTools(policy, runner?): ToolDefinition[]` exposes run_command and compatible structured run_shell. Results include executable/argv/cwd/exitCode/stdout/stderr previews and timeout/cancellation metadata. Reuse generic tool deadline signal; keep sandbox/network/approval rules.

- [x] Write failing real subprocess tests for bun test/typecheck-like argv, bounded output, cancellation, timeout and surviving descendants; verify failures.
- [x] Enable approved project validation commands without shell strings; preserve secrets/environment/path policy and terminate the process group.
- [x] Run command tests including supported macOS sandbox integration; expect pass. Commit the command implementation with Phase 7 integration.

### Task 4: Phase 7 generic execution policy and spill

**Files:** tools/executor.ts, tools/execution-journal.ts, tools/tool-deadline.ts, tools/output-store.ts, core loop policy, Native runtime/index integration and tests; migration if required.
**Interfaces:** A derived AbortSignal enforces one-attempt deadlines (all retries individually bounded). Canonical results validate before durable success; renderOutput controls model text only. Durable fullResultRef/storageKey values resolve through a session/workspace-scoped bounded retrieval tool. Consecutive canonical tool calls advise at 3/5/8 independently of infrastructure retries.

- [x] Add failing deadline, invalid output, spill retrieval/isolation, repeat advisory and recovery integration tests; confirm failures.
- [x] Reuse DeepSeek loop/preview logic where compatible; integrate retry-safe deadlines and durable output storage without weakening Phase 4 persistence failure handling.
- [x] Run focused runtime/executor tests and full suite; expect pass. Commit Phase 7.

### Task 5: Phase 8 acceptance and documentation

**Files:** fault-injection integration tests, doc/native-tool-audit.md, doc/single-agent-phase5-8-acceptance.md, execution authority docs/ADR/architecture and third-party attribution.
**Interfaces:** An acceptance matrix maps every supplied Definition of Done item to code and runnable tests; complete Native tool audit lists purpose/risk/idempotency/capability/deadline/schema/examples/cancellation/failures/doc accuracy.

- [x] Exercise fresh DB/upgrade, staged create/write/delete/move interruption, provider/tool checkpoints, durable result gaps, approval expiry, replay and continued model history. Add regression cases for uncovered boundaries before fixes.
- [x] Run `bun test`, `bun run typecheck`, `bun run lint`, `bun run --cwd apps/desktop build`, and `git diff --check`; expect all pass.
- [x] One fresh independent whole-branch review; reproduce and fix correctness findings, then rerun required checks.
- [ ] Commit and push; create and attach one PR targeting main. Report exact changes, verification, and remaining task count without claiming unimplemented guarantees.

## Execution notes

- Completed all four implementation tasks and Phase8 fault/acceptance coverage. The interoperating changes are committed together so each reviewed revision builds with the full production registry.
- Verification before independent review: 744 tests passed with no skip, including real macOS sandbox cases; typecheck, lint, desktop production build and diff checks passed.
- Reused pinned DeepSeek atomic-write and repeat-call code where compatible; schema/command behavior adapted to existing Socrates IO and security seams.

- Final fresh review found three Important issues (committed evidence cleanup, normal-exit descendant cleanup, semantic input correction). All reproduced RED then fixed GREEN; follow-up eager-SDK regression also passed. Final full suite754 pass/no skip/no fail; typecheck/lint/desktop build/diff-check pass.
