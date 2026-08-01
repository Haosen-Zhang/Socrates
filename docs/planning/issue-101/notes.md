# Notes: Unified Room Sidebar

## Findings

- `ChatPage` currently owns a local `AppMode` state and renders
  `ModeSegmented`; selecting a room synchronizes that state back to its legacy
  kind.
- `sidebarLists.ts` deliberately filters Chat and Co-work into disjoint views.
- New rooms already use the unified session creation flow, but old `rooms`
  records still contain user history and must remain reachable.
- Collapsing the sidebar is a separate window-layout defect and will be handled
  by the dependent window-chrome ticket after #101 merges.
- The compatibility projection treats both `workspaceId = null` and references
  to a missing workspace as top-level rooms. This prevents stale local metadata
  from hiding durable history.
