# Issue #97 Delivery Record

## Implemented

- Replaced legacy Boss-centric room collaboration data with explicit execution
  strategy, Agent assignment, optional discussion, plan confirmation, and
  independent tool policy.
- Added global collaboration defaults that are copied into new rooms and can be
  restored without mutating either existing rooms or the global source.
- Added a backend capability handshake and fail-closed validation for adaptive
  collaboration, routing, discussion, and plan-confirmation modes.
- Added room-scoped collaboration editing, explicit primary Agent persistence,
  active-session locking, role repair after member removal, and single-member
  degradation.
- Added migration 014 to preserve and normalize existing room collaboration
  data.
- Rebuilt the collaboration settings UI and added a global defaults section.
  Unsupported runtime controls remain visible but disabled with a clear reason.

## Verification

- `bun test`: 474 pass, 2 platform-dependent skips, 0 fail.
- `bun run typecheck`: pass.
- `bun run lint`: pass (233 files).
- `bun run --cwd apps/desktop build`: pass.
- `git diff --check`: pass.

## Known limitations

- Adaptive collaboration and task routing remain intentionally unavailable
  because the backend runtime does not implement them.
- Plan confirmation currently supports user confirmation only.
- The existing Vite large-chunk warning remains; it is not introduced by this
  ticket.
