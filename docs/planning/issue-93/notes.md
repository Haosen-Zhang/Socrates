# Notes: Issue #93

- Latest baseline: `b1bf544`.
- Existing opener plugin version exposes `revealItemInDir`.
- `opener:default` already includes `allow-reveal-item-in-dir`; no capability expansion is required.
- Workspace records persist `canonicalPath`.
- Session records persist `workspaceId`; legacy Room records do not have a workspace path.
- A stale session binding resolves to an explicit missing state so the menu action
  can report the data problem instead of disappearing silently.
- The native reveal adapter is injected in its regression test, keeping the
  path-resolution tests runnable outside Tauri.
