# Notes: Issue #113

## Reference

- OpenCode repository: https://github.com/anomalyco/opencode
- License: MIT, copyright 2025 opencode.
- Reviewed files:
  - `packages/ui/src/components/resize-handle.tsx`
  - `packages/ui/src/components/resize-handle.css`
  - `packages/app/src/pages/layout.tsx`
  - `packages/app/src/context/layout.tsx`

## Initial findings

- OpenCode uses an 8px invisible drag target, clamps widths, disables text
  selection while dragging, and persists widths through layout state.
- Socrates already persists the left sidebar width in `config.toml`, but has no
  drag handle. The right dock width is currently hard-coded in CSS.
- Socrates Room Overview already renders current/cumulative/cache/reasoning token
  values. This ticket should add effort and an honest context-window ring rather
  than rebuilding the section.
