# Notes: UI-002 Collaboration Settings

## Baseline

- `bun test`: 469 passed, 2 existing platform skips, 0 failed.
- `bun run typecheck`: passed.
- `bun run --cwd apps/desktop build`: passed with existing Vite chunk warnings.

## Existing call chain

- Canonical legacy model: `packages/core/src/room-kind.ts`.
- Room persistence: `sessions.collaboration_json`, read and validated by
  `apps/sidecar/src/store/session-store.ts`.
- Room API: `PUT /sessions/:id/collaboration`.
- Runtime consumer: `apps/sidecar/src/multi-agent/coordinator.ts`.
- Desktop editor: `CoworkRoomSettingsDialog` in
  `apps/desktop/src/ChatPage.tsx`.
- Global config has no collaboration defaults.
- `/agent-runs/capabilities` currently advertises only tool approval modes.

## Runtime capability decision

- `single`: supported by `SingleAgentRunner`.
- `team`: supported by the existing durable `MultiAgentCoordinator`.
- `adaptive`: unavailable; UI must disable it from the backend handshake.
- No new scheduler or Manager–Worker behavior will be added.

## Canonical model

- `strategy`: `single | adaptive | team`.
- Agent assignment keeps `primaryAgentId` as the Session authority, plus
  coordinator/callable-member/routing fields in collaboration JSON.
- `discussion` is an object with independent `enabled`, retained mode/round/order
  settings, and summary Agent.
- `planConfirmation` is separate from the existing room Tool Policy.
- Global defaults use the same normalized shape; room-relative missing roles
  resolve to the explicit primary Agent when copied/restored.
