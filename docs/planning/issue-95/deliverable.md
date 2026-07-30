# Issue #95 Delivery Record

## Delivered

- Room creation now asks only for a name, managed/existing workspace, and Agent
  members. The API rejects workspace-less legacy creation requests.
- The default execution Agent is persisted explicitly as `primaryAgentId`; it is
  not inferred from member order.
- Managed room workspaces live under
  `~/Documents/Socrates/Workspaces/<room-id>/`, retain stable ownership metadata,
  and can be kept or deleted explicitly when a room is deleted.
- Managed deletion stages the directory before the database transaction,
  restores it if the transaction fails, and never reports a false whole-request
  failure after the database commit.
- Unknown model context metadata uses a conservative runnable fallback rather
  than the previous 4,096-token ceiling. Known provider limits remain enforced.
- Pre-provider context-budget failures are shown immediately above the composer
  with a localized recovery message.

## Data and protocol

- Migration 013 adds `ownership` and `owner_session_id` to workspaces, backfills
  existing records as external, and enforces managed ownership invariants.
- `POST /sessions` requires `workspaceSelection.kind` to be `managed` or
  `existing`; all newly created rooms persist as working rooms.
- `DELETE /sessions/:id` requires `workspaceFiles=keep|delete` for an owned
  managed workspace.

## Verification

- Focused regression: 43 passed, 0 failed.
- Full `bun test`: 469 passed, 2 existing platform-dependent skips, 0 failed.
- `bun run typecheck`: passed.
- `bun run lint`: 228 files checked, passed.
- `bun run --cwd apps/desktop build`: passed; only the existing Vite chunk-size
  and mixed static/dynamic import warnings remain.
- Second-pass standards and specification reviews completed after addressing
  deletion rollback, legacy API bypass, baseline test restoration, and real
  native-tool schema budget coverage.

## Manual verification requested

- Create a managed-workspace room and an existing-workspace room.
- Confirm the initial modal shows no red validation state.
- Delete managed rooms once while keeping files and once while deleting files.
- Send a first message with a Provider whose context-window metadata is absent
  and confirm either a streamed reply or the visible localized budget error.
