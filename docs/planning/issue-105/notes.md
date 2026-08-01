# Notes: Workspace Explorer and Git Diff Dock

## Sources

Full commit-pinned findings are in `reference-research.md`.

## Existing Socrates Seams

- `contentRoutes` already owns workspace-scoped authenticated inspection APIs.
- `WorkspacePathPolicy` already provides canonical containment, secret denial,
  symlink/hardlink protection, and bounded reads.
- `searchWorkspacePaths` and `list_directory` already contain bounded traversal
  behavior, but the dock needs direct-child lazy listing rather than a full walk.
- The shared `WindowRoomToolbar` is the correct button host; no new navigation
  layer is needed.

## Decision

- Follow Reasonix's flattened expanded-row model and stale-request protection,
  while reusing `@tanstack/react-virtual` rather than copying its component.
- Follow Codex/grok-build fixed-argument, bounded Git acquisition rules by
  reusing Socrates' supervised command runner; never accept a desktop-provided
  cwd or arbitrary Git arguments.
- Isolate `@git-diff-view/react` behind a Socrates `DiffView` component and use
  its pure CSS entrypoint so it can be themed without importing another design
  system.
- MIT dependencies are pinned; no reference-project source is copied.
