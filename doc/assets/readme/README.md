# README artwork and captures

The SVGs are original, self-contained illustrations. They use the same local
identity renderer as the application, without external fonts or avatar services.

Regenerate the English and Chinese artwork from the repository root:

```bash
bun scripts/readme/generate-assets.ts
```

The PNGs show the actual React application with **fictional demonstration data**.
They are not evidence of real model outputs or completed workspace changes.
Model names identify the illustrative cast, not benchmarked capabilities.

To recreate captures, start a fresh isolated fixture and the development UI in
separate terminals:

```bash
SOCRATES_README_PREVIEW=1 bun apps/sidecar/scripts/chat-work-preview.ts
bun run --cwd apps/desktop dev --host 127.0.0.1 --port 45328
```

With Playwright and Chrome available, run:

```bash
node scripts/readme/capture.mjs
```

If Playwright is installed outside the repository, set
`SOCRATES_PLAYWRIGHT_MODULE` to its `index.mjs` path. The capture script also
checks identity generation, uploads, persistence and the compact editor layout.
It writes screenshots here and verification results to
`output/playwright/personas/`. Restart the fixture before rerunning; it uses
an in-memory database and a temporary workspace, with no real API credentials.

`scripts/readme/preview.mjs` renders GitHub Markdown output supplied as
`/tmp/socrates-readme-en.html` and `/tmp/socrates-readme-zh.html`, checks local
links and image loading, and captures desktop and narrow layouts. Preview HTML
and visual inspection files stay under `output/playwright/personas/`.
