# P08 local browser acceptance

Run from the repository root with Bun, Node.js and Google Chrome installed.
Playwright is an optional local testing prerequisite, not a production dependency:

```sh
npm install --no-save --package-lock=false playwright
node scripts/p08-browser.mjs
```

Alternatively point `SOCRATES_PLAYWRIGHT_MODULE` to an existing Playwright module. The runner resolves it from the repository before creating temporary scripts, so bare module resolution does not depend on the scratch directory.

`SOCRATES_P08_UI_PORT` overrides the isolated Vite port (default 45358). `SOCRATES_P08_FLOWS=p08-stress` selects one flow; the default runs cost-aware, routing, verification, project-memory, flight-recorder, arena, p08-interactions and p08-stress.

The runner creates fresh temporary SQLite databases/workspaces, local controlled model providers and real production React/service instances. It starts and stops only its own processes. It does not use user databases or paid APIs. Artifacts are written to `output/playwright/p08/`. Requests remain local; each flow records assertions, renderer errors and external-request counts.

The stress fixture seeds explicitly synthetic ledger facts through the real ledger API (USD/CNY atomic-unit samples and an unknown result). A real approved `bun test` process generates 2,000 diagnostic lines. An intercepted local event request receives a connection reset; recovery, model-call counts and room isolation are then checked against persistent services.

Composition events verify Enter handling, not the operating system's IME candidate window. Accessible names/focus are checked, not native screen-reader speech. These browser checks do not validate the packaged Tauri application.
