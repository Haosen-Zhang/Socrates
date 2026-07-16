# ADR 0005: Workspace capability and exact approvals

- Status: Accepted; read boundary implemented, write adapters incomplete
- Date: 2026-07-16

## Decision

A folder picker result is user intent, not filesystem authority. The sidecar canonicalizes it, stores an opaque workspace identity and validates every relative path using lexical normalization, `realpath`, containment, symlink and secret checks. The renderer receives no Tauri filesystem or shell capability.

Permission evaluation uses the strict order: global hard deny, runtime/agent ceiling, mode/phase ceiling, scoped rules, exact approval/grant, safe default. Model text is never approval evidence. Chat has no tools; Multi-Agent discussion and synthesis are read-only; only one designated execution Agent may hold the canonical workspace write lease.

Plan approval permits entering execution for an exact plan. It does not grant a concrete command, patch, path or network action. Tool approval binds input hash, workspace identity, attempt and policy version. Destructive, outside-write and secret operations always require fresh human review and cannot become session grants.
