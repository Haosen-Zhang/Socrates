# Notes: Window Chrome

## Findings

- The previous collapse state only changed the rail from `w-64` to `w-14` and
  kept the restore button inside that rail. A collapsed sidebar therefore still
  occupied width, retained its border/shadow, and owned the only restore action.
- Legacy rooms, Single Agent sessions, and Multi-Agent sessions each rendered a
  separate header. The shared toolbar now keeps room identity and actions in one
  stable desktop-chrome location for all three surfaces and the empty state.
- Tauri 2 supports an overlay title bar, custom traffic-light position, window
  fullscreen queries, resize events, and an explicit start-dragging capability.
- There is no real console panel/action in the current desktop application, so
  Issue #103 intentionally does not render a decorative or inert console button.
- Hidden sidebar state remains persisted in the existing config. The mounted
  element becomes inert and transitions to zero width, padding, border, shadow,
  opacity, and pointer interaction; reduced-motion removes the transition.
