# Deliverable: Issue #111

## Outcome

Agent create/edit now uses one required, model-aware reasoning-effort select.
The default is always `auto`; unsupported values are rejected by the sidecar.

## Main files

- `packages/core/src/model-capabilities.ts`: shared model-family catalog.
- `apps/sidecar/src/agents.ts`: server-derived profile and validation.
- `apps/sidecar/src/gateway-aisdk.ts`: Provider-specific payload mapping.
- `apps/desktop/src/ReasoningEffortSelect.tsx`: single polished selector.
- `apps/desktop/src/AgentsSection.tsx`: create/edit integration.

## Compatibility and migration

No database migration is required. Existing nullable rows read as `auto`; an
Agent's model/provider change also resets an incompatible legacy selection to
`auto`.

## Known limits

- The model-family catalog is conservative and must be updated as Provider APIs
  change. Unknown or self-hosted open-weight models default to `auto/disabled`;
  additional levels appear only when preserved capability metadata declares them.
- No real credential/API request was made during this ticket; request-shape and
  route behavior are covered by deterministic tests.
