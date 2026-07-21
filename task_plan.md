# Task Plan: Socrates proxy and product polish tickets

## Goal
Ship the reported proxy, provider form, composer, agent, room sidebar, and pixel-theme improvements as reviewable one-ticket branches and pull requests, each with regression coverage and green project checks.

## Phases
- [x] Phase 1: Synchronize `main`, inspect current behavior, and create GitHub tickets
- [x] Phase 2: Fix macOS auto proxy discovery and provider type/model selectors
- [x] Phase 3: Fix IME-safe composer behavior and Reasonix-inspired pixel interactions
- [x] Phase 4: Enforce unique agent nicknames and add avatar upload
- [x] Phase 5: Redesign room creation/sidebar with avatar selection and archive placement
- [x] Phase 6: Add named themes and generated twentieth-century pixel icon theme
- [x] Phase 7: Run full verification, open PRs, and prepare handoff

## Key Questions
1. Which requested fixes are already present on current `main` after the latest merges?
2. What seam can reproduce each reported bug deterministically before the fix?
3. How does Reasonix implement composition handling, composer transitions, and settings navigation without copying project-specific code?
4. Which OpenAI model should count as the cheapest selectable default based on the provider's returned model list and Socrates' compatibility rules?

## Decisions Made
- Keep one ticket per branch/PR, as required by `AGENTS.md` and the user.
- Never store or print the supplied API key; use existing Keychain credentials for live checks if needed.
- Treat the generated icon theme as the last ticket because project-bound image assets require a dedicated image-generation step.

## Errors Encountered
- `CONTEXT.md` is referenced by the debugging skill but absent in this worktree; read the relevant ADRs instead.
- GitHub issue bodies containing Markdown backticks were passed through a shell command string, so zsh performed command substitution and unintentionally ran the existing test/typecheck/build commands while creating #48-#52. All commands passed and no source files or secrets were changed. Issue bodies will be normalized without shell-sensitive quoting.
- The first #49 Tauri visual check could not start because port 1420 is already occupied by an existing Node/Vite process. The existing process was left untouched; the branch will be launched with a temporary Tauri config on port 1422.

## Status
**Complete** - #48-#52 and #58 are delivered as independent PRs; #57 conflict was resolved and reverified.
