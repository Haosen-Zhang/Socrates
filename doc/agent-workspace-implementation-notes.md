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
