# Notes: Responsive workspace shell and overview dock

## Existing Socrates seams reused

- `WorkspaceDock` already owned safe workspace listing, preview and Git diff.
  It now hosts a controlled three-tab shell instead of duplicating those IO
  paths.
- `usageSummaries` remains the only UI source for current/cumulative usage;
  null fields are rendered as unavailable.
- `SessionMembersDialog` and `RoomMembersDialog` remain the mutation surfaces.
  Overview only links to them.
- `PixelIcon` already selected Pixel 1998 through `data-ui-theme`, so the
  default modern SVG layer can coexist with the existing pixel sprite.

## Reference review

- The supplied right-dock reference uses a stable tab strip and keeps metrics
  out of the conversation header. Socrates adopts that information hierarchy,
  not its styling or runtime state.
- `/Users/haosen/Downloads/source-code-for-research` is a decompiled Claude Code
  TUI research tree, not a directly reusable desktop React shell. No source was
  copied from it; its controlled-tabs and pinned-layout ideas only confirmed
  the existing Socrates approach.
- Lucide provides maintained React SVG components under ISC, with some
  Feather-derived icons under MIT. The dependency and attribution are recorded
  in `docs/third-party-notices.md`.

## Visual verification

- 1080x720 Tauri window: Overview is a normal right column and the top bar is
  reduced to room identity and icon actions.
- 760x540 Tauri window using a temporary override config: the dock becomes an
  overlay; title and actions stay on one line without vertical glyph wrapping.
- The local profile was set to Pixel 1998, so the smoke screenshot verified the
  preserved pixel branch. The default Lucide branch is covered by SSR tests.
