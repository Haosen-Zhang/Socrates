# Chat / Work and room-member collaboration

Base: origin/main e13de16. Branch: codex/chat-work-member-collaboration.

## Design and execution
Preserve the existing React/Tauri/Bun product, Native Runtime, event and recovery authority. Room kind (chat/cowork), persistent members, explicit collaboration strategy and per-command targets remain independent. New Chat rooms use sessions without workspace or tools; existing legacy rooms remain readable. Commands persist structured mentions and stable request identity. Member snapshots freeze template configuration, run profiles freeze execution. Team work packages reuse native execution and a single workspace writer queue.

## Phases
- [x] A1 Inspect current main, architecture and user requirements; isolate branch; preserve .reasonix changes.
- [x] A2 Frozen profiles, honest budget interruption and shared workspace leases.
- [x] B Chat/Work navigation, room drafts, inline reusable role editor and member configuration.
- [x] C Structured command routing, idempotency, bounded discussion and room isolation.
- [x] D Persistent work packages, distinct owners, dependency execution, review, stop and recovery.
- [x] E Full test/typecheck/build gates, UI verification and document synchronization.

## Ownership
- runtime_foundation: native and member runners, profiles, leases.
- frontend: desktop components and state.
- team_execution: coordinator, team/work-package persistence and routes.
- root: room commands, sessions, migration registration, production wiring, integration and docs.

## Validation
Meaningful route/config/state/lease/recovery tests plus reproducible two-member team execution including failure and retry. Run bun test, bun run typecheck, bun run --cwd apps/desktop build and browser interaction checks. No supplied provider credential; mocked-provider evidence is reported separately.

## Findings / constraints
- Local main was behind; fetched remote and started at latest e13de16.
- Sandbox gh check initially reported invalid auth; host recheck verified authentication. The user subsequently requested PR publication; tracked as GitHub issue #136.
- Initial sandbox git fetch denied .git write; authorized escalation succeeded.

## Status
Completed A–E. Final host gate: bun test 828 pass / 0 fail, including all four macOS command tests. Typecheck and desktop build pass. Targeted lint covers changed TS/TSX. Twelve browser checks passed with no page errors. No real Provider API or native Tauri window verification.


## Verification history
- One earlier concurrent sandbox test run hit the existing command-runner 100 ms deadline in `stops background mutations before returning a normally exited leader’s result`; isolated retry and later full host suites passed. No timeout thresholds or production process policy were loosened.
- Playwright CLI wrapper was not executable and its daemon socket was unavailable between calls; validation used the installed Playwright module in an isolated Chrome process. Temporary browser diagnostics were removed; passing evidence remains in output/playwright.
- Final review P2 findings (unknown-package recovery confirmation; hidden team discussion error) fixed with regression tests.

---

## Prior development record (preserved)

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
