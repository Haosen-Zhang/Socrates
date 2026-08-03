# Deliverable: Issue #113

To be finalized after implementation and verification.
# Issue #113 delivery

## Implemented

- Per-Agent current/cumulative/cache usage and effective reasoning effort.
- Honest context-window ring based on current input tokens and known model capacity.
- Hover/focus detail tooltip, explicit unavailable state, and over-capacity diagnostics.
- Pointer and keyboard resizing for both sidebars, persisted in `config.toml`.
- Responsive clamping, narrow-screen right-dock overlay, and truncated dock labels.
- MIT OpenCode interaction reference recorded in third-party notices.

## Verification

- `bun run lint`
- `bun test` — 508 passed, 2 skipped, 0 failed
- `bun run typecheck`
- `bun run --cwd apps/desktop build`
- `bun run --cwd apps/desktop test:visual` — 8 passed, build passed
- `bun run dev` — Vite ready, Rust/Tauri compiled, desktop binary launched

The existing Vite chunk-size warnings remain informational and predate this ticket.
