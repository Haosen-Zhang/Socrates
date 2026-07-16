# Agent Workspace threat model

Status: Living security gate. Implemented controls and open blockers must be tracked separately.

## Assets and trust boundaries

- Assets: workspace files, uncommitted changes, credentials, provider payloads, approval records and audit history.
- Untrusted inputs: model output, repository content, attachments, MCP metadata/results, external runtime events and filenames.
- Boundaries: renderer to authenticated loopback sidecar; sidecar to provider/MCP; sidecar to runtime child; runtime/tool to canonical workspace.

## Required controls

| Threat | Required control | Current state |
| --- | --- | --- |
| Traversal/symlink escape | relative normalization, canonical containment, symlink rejection, file identity recheck | Implemented for native reads |
| Secret exfiltration | deny patterns, Keychain refs, recursive redaction, no secrets in model context | Read deny implemented; proxy secret migration pending |
| Prompt-injected approval | only durable human decision is evidence | Implemented in permission/approval contracts |
| Approval replay | exact input/workspace/attempt/policy binding | Implemented |
| Concurrent writers | one canonical workspace write lease | Implemented; execution adapter pending |
| Duplicate side effects | stable key plus input hash, no unknown replay | Implemented in ToolExecutor contract |
| Renderer compromise | no fs/shell capability; narrow dialog permission; authenticated loopback | Picker capability implemented; broader CSP/CORS verification pending |
| Runtime compromise | pinned binary/schema/hash, sandbox, supervised process tree | Pending Codex adapter |
| MCP supply-chain/tool drift | generation pin, local risk override, approval and backoff | Pending MCP milestone |

## Release blockers

Native arbitrary shell, outside-workspace write, automatic destructive approval, plaintext credentials, danger-full-access and silent capability downgrade are release blockers.
