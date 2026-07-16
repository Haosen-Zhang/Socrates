# ADR 0007: Codex app-server adapter

- Status: Accepted; not implemented
- Date: 2026-07-16

## Decision

Socrates will integrate a pinned and verified `codex app-server` protocol over stdio for the first production write/file-change/shell runtime. Binary version, protocol schema and release hash must be matched. Stdout is protocol-only; stderr is recursively redacted.

Socrates remains the authority for workspace consent, product state, plan approval, tool approval and audit. Codex command/file approval requests are projected into the common ToolCall and Approval schemas. The adapter may use only read-only or workspace-write sandbox modes; danger-full-access, auto approval and unsandboxed shell APIs are forbidden.

Malformed messages, timeout, crash and protocol drift fail closed. Interrupt first requests graceful cancellation, then terminates the process tree after a bounded grace period. Production writes remain disabled until transcript, fake-child and real supported-binary tests pass.
