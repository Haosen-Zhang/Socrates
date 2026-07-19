# Notes: Socrates proxy and product polish

## Sources

### Socrates repository
- Local workspace: `/Users/haosen/Developer/Socrates/.claude/worktrees/skills-repo-setup-3cd946`
- `origin/main` currently points to merge commit `55c6a2e`, which includes PR #47.
- The main checkout is owned by `/Users/haosen/Developer/Socrates`; this worktree must branch directly from `origin/main`.
- Relevant ADR: the sidecar is a Bun process spawned by Tauri and owns outbound provider requests, so macOS proxy discovery belongs in `apps/sidecar`.

### DeepSeek Reasonix
- URL: https://github.com/esengine/DeepSeek-Reasonix
- Relevant composer, transition, and settings patterns will be recorded after source inspection.

### OpenAI model pricing
- Official model catalog: https://developers.openai.com/api/docs/models
- Official GPT-5 page lists GPT-5 nano at $0.05 input per million tokens and as the nano tier.
- Official GPT-4o mini page lists $0.15 input and $0.60 output per million tokens.
- Official GPT-5.4 nano page lists $0.20 input and $1.25 output per million tokens and calls it the cheapest GPT-5.4-class model.
- Socrates therefore uses an explicit current low-cost alias ordering, filters out embedding/audio/image/moderation models, and falls back to tier hints such as nano, mini, and luna for future returned IDs.

## Existing diagnosis supplied by the previous work session
- macOS system proxy is configured at `127.0.0.1:6789`.
- Direct OpenAI traffic timed out, while explicit HTTP and SOCKS proxy probes returned promptly.
- Socrates auto mode timed out because the sidecar only read proxy environment variables; Tauri did not pass macOS system proxy settings.
- Explicit custom HTTP proxy mode succeeded, so TUN mode was not required for the reproduced case.

## Synthesized Findings

### Ticket map
- #48: macOS auto proxy discovery.
- #49: provider type/model selectors and cheapest OpenAI default.
- #50: IME-safe composer and fluid pixel interactions.
- #51: unique agent nicknames and custom avatar upload.
- #52: pixel room sidebar and avatar-based creation modal.
- #37: named themes and generated pixel icon theme.

### Security
- User-provided API keys must remain outside the repository and tool output.

### #48 macOS auto proxy
- Red-capable command: `bun test apps/sidecar/src/net.test.ts`; before the fix it returned `undefined` instead of `http://127.0.0.1:6789` when proxy env was absent and a representative `scutil --proxy` payload was supplied.
- Root cause: `resolveProxyFor` only considered HTTP proxy environment variables. The Tauri-spawned sidecar did not inherit those variables.
- Fix: preserve environment precedence, then read `/usr/sbin/scutil --proxy` on Darwin, parse enabled HTTPS/HTTP/SOCKS records, and cache the system query for five seconds.
- Live macOS smoke test with proxy env removed resolved `http://127.0.0.1:6789`; an unauthenticated OpenAI models request returned HTTP 401 within ten seconds instead of timing out.

### #49 provider selectors
- Red-capable command: `bun test packages/core/src/provider.test.ts apps/sidecar/src/providers.test.ts`.
- Before the fix it showed three exact failures: provider PUT kept `openai_compatible`, draft model discovery returned 404, and the low-cost selector export did not exist.
- Root cause of the inert type control: the edit form explicitly set `disabled={editingId !== null}` and the provider PUT route ignored type.
- Root cause of the missing default-model picker: model loading existed for provider cards and Agent editing, but the provider modal always rendered a text input and had no draft-credential discovery endpoint.
