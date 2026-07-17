# Agent Workspace Implementation Notes

## Milestone 0

### Approved constraints

- Renderer remains unprivileged.
- Chat has no filesystem or shell tools.
- Multi-Agent discussion and synthesis are read-only.
- Plan approval is distinct from concrete high-risk tool approval.
- Unknown non-idempotent side effects are never automatically replayed.
- Usage missing from a provider is `unavailable`/`null`, never fabricated.

### UI regression seams

- `PixelIcon` public component structure and theme variants.
- Pure interactive-root entry predicate for delegated hover audio.
- Global click qualification and `pixelBurstAt` node lifecycle.
- Existing business components must contain no local particle call sites after migration.

### Baseline results

- `bun run lint`: baseline failure, script absent (`error: Script not found "lint"`).
- `bun test`: 87 pass, 0 fail, 16 files, 305 assertions.
- `bun run typecheck`: pass.
- `bun run --cwd apps/desktop build`: pass; 304 modules; JS 429.13 kB, CSS 33.81 kB.
- Isolated sidecar smoke: sandbox bind failed as expected; approved local run emitted `socrates-sidecar/1` on port 60728 and authenticated `/health` returned `{"ok":true}`; process terminated.

## Milestone 1 results

- Replaced 418px sprite sampling for micro icons with hard-edge SVG rect rendering; the sprite is now explicit `decorative` only.
- Top tabs and settings/sidebar utility icons use 20px micro icons with at least 36px interaction height where applicable.
- Delegated hover compares target and related interactive roots; touch/disabled/hidden/inert controls do not play hover.
- One capture-phase global click owner calls `pixelBurstAt(clientX, clientY)`; all local burst call sites were removed.
- Particle nodes use `pointer-events:none`, a 120-node budget, guaranteed cleanup, and reduced-motion suppression.
- Targeted tests: 7 pass. Full suite: 92 pass, 0 fail, 18 files, 329 assertions.
- `bun run typecheck`: pass. Desktop build: pass, 306 modules.
- Tauri dev: Rust build and app launch succeeded.
- Visual fixture: 1x and 2x screenshots across 80/100/125/150%, light/dark, classic/Pixel 1998; no fractional icon transform or source halo on micro icons.
- Browser interaction: one click produced one 12-particle burst; expected `(57,1219)` matched computed `left:57px; top:1219px`; reduced motion produced zero nodes.
- Temporary evidence: `/tmp/socrates-m1-icon-matrix-1x-final.png`, `/tmp/socrates-m1-icon-matrix-2x-final.png`.

## Milestone 2 foundation checkpoint

- Replaced ad-hoc startup ALTERs with three forward-only migrations, SHA-256 checksum validation, `BEGIN IMMEDIATE`, complete rollback and pre-upgrade `VACUUM INTO` backup.
- Added SessionStore with `chat/single_agent/multi_agent`, immutable Agent snapshots, workspace binding lock and legacy-running interruption; old Room tables/APIs remain intact.
- Added journal-first EventStore with strict per-session sequence, event ID deduplication, append+projection transaction and cursor replay API. Live replay SSE and desktop gap recovery remain open.
- Added canonical Workspace selection/recent persistence and a native Tauri folder picker with only `dialog:allow-open`; Renderer still has no filesystem/shell permission.
- Workspace native reads reject traversal, absolute paths, secret patterns, symlinks, multi-link hardlinks, binary/non-UTF-8 input and file identity races; native output is bounded.
- Added five read-only builtins, generation-aware ToolRegistry, stable input hash/idempotency, bounded ToolExecutor output, durable exact ApprovalManager and one-writer WorkspaceLeaseManager.
- PermissionManager fails closed by mode/phase; Chat has no tools and Multi-Agent discussion/synthesis cannot write. Plan approval remains distinct from tool approval.
- Added normalized capability/usage/runtime contracts and RuntimeManager recovery. Unknown usage is `null`/unavailable.
- Added pinned Codex CLI 0.144.5 protocol projection and JSONL child supervisor tests for correlation, server approval, interrupt, timeout, malformed output and crash. Production write/shell remains disabled.
- Added Biome lint gate; tightened loopback Host/Origin/CORS and Tauri CSP. Proxy credential migration and recursive diagnostic redaction remain open under SEC-001.
- Added ADR 0004–0007 and a threat model; generated protocol artifacts were inspected from the local 0.144.5 binary and were not copied wholesale.
- Dependency changes: official `@tauri-apps/plugin-dialog` / `tauri-plugin-dialog` and `@biomejs/biome`, with Bun/Cargo lockfiles updated.
- Verification to date: targeted suites pass; `cargo check` passes; authenticated sidecar smoke returns 200, malicious Origin returns 403 and valid CORS preflight returns 204.

## Milestone 3 implementation checkpoint

- Added P2 migration tables for runs, structured session messages/parts, attachments, Workspace-bound sources and opaque Workspace refs.
- Single Agent preparation is atomic across run, journal event, user message/parts and session state; failures roll back all projections. Completion, failure and cancellation states are durable and Runtime sessions are closed after terminal state.
- Added a real AI SDK Native runtime limited to Workspace read/list/search tools and eight model steps. It persists bounded tool results and never exposes write/shell/network/MCP tools.
- Added the pinned Codex app-server runtime adapter for read-only/workspace-write sandbox, text/reasoning/tool/usage mapping, exact Socrates approval handoff, interrupt and attachment/ref conversion without sending local absolute paths.
- Added native file picker, Tauri drag/drop and clipboard byte upload. Imports are size/MIME/hash checked, atomically stored outside SQLite, deduplicated and bound to the active Session Workspace.
- Added bounded `@path` search and opaque refs with send-time Workspace/hash validation. Native text/ref context is tagged as untrusted; unsupported images fail explicitly instead of being dropped.
- Added authenticated image Blob previews with URL revocation, `nosniff`, sandbox CSP and attachment disposition for non-images. Draft text/attachments remain after failed or cancelled runs.
- Current known gaps: legacy Room Chat is not yet migrated to Session replay/structured attachments; attachment retention GC and explicit upload retry/progress remain; Native image support waits for reliable per-model capability data; real credentials were not used.

## Milestone 4 implementation checkpoint

- Added official `@modelcontextprotocol/sdk` 1.29.0 behind a local adapter, with stdio and Streamable HTTP negotiation, bounded pagination, same-origin/manual-redirect HTTP enforcement and deterministic real-SDK fixture coverage.
- Added global/workspace MCP server settings and state, Keychain-only env/header values, redacted export/diagnostics, enable/disable/test lifecycle, graceful teardown and 1/2/5/10/30 second jittered crash recovery. Authentication errors stop automatic retry.
- Discovery snapshots tools, resources, resource templates and prompts per server generation. Tool schemas have byte/depth/node limits; invalid tools degrade the server without entering ToolRegistry. Catalog entries remain metadata-only and untrusted.
- Native Agent sees only current-generation allow/ask MCP tools. Denied tools are absent; ask tools use AI SDK approval requests projected into the existing durable ApprovalManager, and execute only after the exact decision. Restarted in-flight runs are interrupted and orphan approvals expired instead of replaying side effects.
- MCP tool outputs and diagnostics recursively redact credential-shaped fields and exact configured secret values before journaling or UI display. Server annotations may raise risk; local overrides can only raise effective risk.
- Added durable per-task/server runtime ownership leases; Native owns Socrates MCP connections while Codex MCP sync stays off, preventing dual hosting and duplicate side effects.
- Migrated legacy proxy username/password and URL userinfo into Keychain before atomic TOML replacement. Renderer reads redacted blanks; sidecar reinjects credentials only when constructing the runtime proxy URL. Migration/write failure preserves the old TOML and rolls Keychain changes back.
- Verification: full gate before final review was 180 tests / 0 failures / 612 assertions; post-review targeted security/recovery tests pass. Typecheck, Biome lint, desktop build, Rust `cargo check`, and isolated authenticated `/health` plus `/mcp/servers` smoke pass. No real credential was used.
