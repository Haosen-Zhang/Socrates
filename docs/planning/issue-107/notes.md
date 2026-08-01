# Notes: New-room project flow and integrated macOS chrome

## Existing reusable seams

- `NewRoomDialog` already supports managed and registered existing workspaces.
- `selectWorkspacePath` already registers a canonical local folder through the
  sidecar and refreshes workspace/MCP state.
- `@tauri-apps/plugin-dialog` is already installed and used for folder picking.
- `WindowRoomToolbar` already owns room title, sidebar toggle and actions.
- Tauri already uses `titleBarStyle: Overlay` and a configured traffic-light
  position.

## Reference inspection

- The supplied `/Users/haosen/Downloads/source-code-for-research` checkout is
  `sanbuphy/claude-code-source-code` at `2ca5dda`; it is a React Ink CLI/TUI and
  has no reusable macOS desktop titlebar/sidebar component.
- The requested Reasonix composition is implemented by preserving a dedicated
  sidebar column under the traffic lights and starting the conversation toolbar
  at the content boundary, rather than overlaying one global toolbar.

## Review corrections

- Reusable project choices must include only external, non-archived
  workspaces. The predicate lives in `packages/core` and managed room-owned
  workspaces are isolated at both UI and route boundaries.
- Folder registration during room creation must not mutate the global active
  workspace. `registerWorkspacePath` is intentionally separate from the
  existing activating `selectWorkspacePath` action.
- Sidebar-offset geometry applies only to macOS overlay windows; fullscreen and
  other desktop platforms retain their existing top toolbar behavior.
