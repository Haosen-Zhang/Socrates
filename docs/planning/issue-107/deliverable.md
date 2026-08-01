# Issue #107 Delivery Record

## Implemented

- Replaced backend-oriented managed/existing room choices with product-facing
  Temporary conversation and Project folder choices.
- Project rooms can bind an already registered workspace or register a folder
  selected through the native macOS directory picker.
- Reusable projects are limited to external workspaces at both the UI and
  sidecar boundaries; another room's managed workspace cannot be rebound.
- Registering a folder from the room dialog does not change the global active
  workspace before the room is created.
- Temporary conversations retain the safe room-owned managed workspace
  contract without exposing its implementation detail.
- Aligned the macOS overlay so traffic lights remain visually in the sidebar
  while the sidebar toggle, room identity and dock controls begin at the
  conversation boundary.
- Bound sidebar and toolbar geometry to the persisted sidebar width and kept
  reduced-motion behavior.

## Verification

- `bun test apps/desktop/src/workspace/newRoomWorkspace.test.ts apps/desktop/src/roomSelection.test.ts apps/desktop/src/window/WindowRoomToolbar.test.tsx apps/desktop/src/window/windowChrome.test.ts` — 18 passed.
- `bun run typecheck` — passed.
- `bun run lint` — 251 files checked, no findings.
- `bun test` — 491 passed, 2 platform-conditional tests skipped.
- `bun run --cwd apps/desktop build` — passed with existing Vite chunk-size warnings.
- Tauri smoke — passed on an isolated `1422` dev URL using a temporary config;
  the branch window launched and a native window capture confirmed that traffic
  lights remain in the sidebar while room controls start at the content edge.
  The existing main checkout on port 1420 was not disturbed.

## Manual interaction check

The unbundled `target/debug/desktop` process did not expose accessibility
controls to the automation runtime. A reviewer should click the New Room flow,
cancel the folder picker once, create one temporary room and one local-folder
project, then collapse/restore the sidebar and enter/exit fullscreen.

## Reuse and licensing

The change reuses Socrates' existing Tauri overlay, dialog plugin, workspace
registration store and room toolbar. No external source was copied and no new
dependency or license obligation was introduced. The supplied reference
checkout is a React Ink TUI rather than a compatible desktop shell.
