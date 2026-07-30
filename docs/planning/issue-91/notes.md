# Notes: Issue #91

## Existing Architecture

- Tool definitions are materialized through `createWorkspaceWriteBuiltins`.
- `WorkspacePathPolicy` and `native-fs.ts` own workspace mutation boundaries.
- `ToolExecutor` performs validation before persistence and approval.
- Room approval policy is durable in `sessions.approval_policy`; migration 012 backfills `ask`.
- The removable runtime banner is rendered in `SingleAgentSession` in `apps/desktop/src/ChatPage.tsx`.

## Dependency Research

- `fflate`: MIT, small pure-JS ZIP implementation with bounded synchronous and streaming APIs.
- `docx`: MIT TypeScript DOCX generator.
- `exceljs`: MIT XLSX/CSV workbook implementation.
- Reasonix is useful for tool-loop and display conventions, but its built-ins are primarily coding/read tools and do not replace Office format libraries.

## Security Constraints

- Every source and destination stays workspace-relative.
- Reject secret paths, symlinks, hardlinks, collisions, root mutation, and traversal.
- Copy/archive traversal has entry-count and total-byte limits.
- Move/rename is destructive and must remain a fresh exact approval.
- Structured input validation happens before durable Tool Call persistence.
- Generated files use exact extensions and no macros or formula execution.
# Implementation notes

- Real baseline after installing the frozen lockfile: 444 passed, 2 skipped;
  typecheck, lint, and desktop build passed.
- New workspace mutations use descriptor-relative `openat`, `mkdirat`,
  `renameatx_np`, and `getdirentries`; symlinks and hardlinks fail closed.
- Files and copied trees are staged under random sibling names, then published
  with exclusive atomic rename; failed staging is cleaned without touching an
  existing destination.
- Copy/archive snapshots are capped at 256 entries and 50 MiB.
- DOCX input is capped at 1,000 paragraphs / 1 MiB UTF-8 including its title;
  spreadsheet input is capped at 10 sheets, 5,000 rows per sheet, 100 columns,
  50,000 cells, and 5 MiB UTF-8.
- CSV/XLSX formula-shaped strings are rejected to prevent formula injection.
- All output tools refuse overwrite. `move_path` is destructive; all other new
  nodes are high risk and remain governed by the room's saved approval policy.
- New and migrated rooms already default to `{ mode: "ask", version: 1 }`;
  existing regression tests cover this persistence contract.
- Independent standards/spec reviews found four boundedness/atomicity issues;
  all blocking findings were fixed before final gates.
