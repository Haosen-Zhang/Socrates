# Notes: UI-003 Task Input

## Findings

- `MultiAgentSession` currently owns per-task order, rounds, synthesizer,
  executor, reasoning-effort, and fallback state and posts all of it through
  `sendMultiTask`.
- UI-002 already made persisted `session.collaboration` authoritative inside
  `MultiAgentCoordinator` for discussion enabled/rounds/order, synthesizer,
  reviewer, and coordinator behavior.
- The existing task DTO remains required by the Runtime store. Desktop can
  derive its compatibility fields from the room without changing the protocol.
- The header still hard-codes `Multi-Agent`; status can be projected from the
  persisted strategy plus current task state.
- `SingleAgentSession` also had a hard-coded English status and no direct room
  collaboration-settings entry. It now projects the same persisted strategy
  and runtime state without changing its Agent execution path.
- The legacy multi-member chat composer is a separate room-chat surface. UI-003
  leaves it intact and limits the simplification to the native task surface.
- The same boundary applies to the Single Agent conversation composer: it is the
  streaming conversation and attachment surface, not the per-task Multi-Agent
  setup form targeted by this ticket. Its header still receives the truthful
  room strategy/status and collaboration-settings entry.
