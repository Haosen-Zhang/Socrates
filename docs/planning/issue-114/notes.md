# Notes: OpenCode-inspired flat theme

## Sources

- OpenCode v2 theme tokens and component CSS use layered neutral surfaces,
  low-alpha borders, compact radii, soft elevation, and a restrained blue
  accent. Socrates adapts those principles through its existing
  `data-ui-theme` seam; no SolidJS component or stylesheet is copied.
- OpenCode is MIT licensed. The design reference and independent adaptation are
  recorded in `docs/third-party-notices.md`.
- The existing `PixelIcon` behavior already routes every non-1998 theme to
  Lucide vector icons, so the flat theme does not need a second icon stack.

## Context defaults and compaction follow-up

This research is intentionally separated from the theme implementation.

OpenCode already implements automatic context compaction. Its provider catalog
supplies `limit.context`, `limit.input`, and `limit.output`; overflow is checked
against the usable input budget after reserving output capacity. On overflow it
keeps a bounded recent tail, summarizes older turns, and prunes old completed
tool outputs while preserving recent tool-call/result context. This is a better
baseline than fixed message-count truncation.

The follow-up ticket should initialize each Agent's editable context window from
model capability metadata, retain the detected/catalog value separately from a
user override, and show `unavailable` for unknown models rather than inventing a
limit.

## Implementation notes

- Added `opencode-flat` as a persisted `UiTheme` value.
- Added localized theme labels in Simplified Chinese, Traditional Chinese, and
  English.
- Scoped every visual override under
  `:root[data-ui-theme="opencode-flat"]` so Classic and Pixel 1998 remain
  unchanged.
- Kept the current React/Tauri renderer and existing user-selected font.

## Errors encountered

- The first source lookup used the Socrates worktree as the OpenCode working
  directory; the command was rerun against the reference clone.
- A broad model-catalog search produced excessive output; subsequent searches
  were constrained to provider and session files.
