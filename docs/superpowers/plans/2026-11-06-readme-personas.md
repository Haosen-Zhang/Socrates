# README and persona implementation plan

**Goal:** Present Socrates in English and Chinese and make AI characters varied
and recognizable.

**Architecture:** Pure identity generation in core, shared source validation in
the sidecar, and one reusable desktop editor/renderer. Static GitHub-compatible
artwork plus actual UI captures illustrate the product.

**Tech stack:** TypeScript, Bun, React, SVG, Markdown, Chrome/Playwright.

**Spec:** [Design](../../../doc/readme-persona-design.md).

## Constraints and review focus

- Preserve all saved avatar sources and legacy fallback identities.
- Keep arbitrary SVG and external URLs out of uploaded avatar sources.
- Avoid nickname collisions, including mixed case and full-width characters.
- Independent controls must preserve an uploaded avatar or custom nickname.
- Ignore obsolete asynchronous upload results after another choice/close.
- No new runtime dependencies; preserve unrelated working files.

## Tasks

- [x] Core: add `agent-identity.ts` and tests; re-export existing identity APIs
  from `chat.ts`. Add locale-aware names and versioned generated-avatar sources.
- [x] Desktop: render generated SVG internally in `AgentAvatar`; extend
  `AgentEditor` with language, name shuffle, avatar gallery, legacy choices,
  and clear upload feedback. Translate new controls in all app languages.
- [x] Verify core/API compatibility, then browser creation, upload and edit flows.
- [x] README: write paired English/Chinese pages with local hero, Chat/Work and
  identity graphics, actual screenshots, accurate setup and architecture links.
- [x] Inspect visuals at GitHub content width and phone width; verify links.
- [x] Run `bun test`, `bun run typecheck`, desktop build and changed-file lint;
  report exact results and validation boundaries.
