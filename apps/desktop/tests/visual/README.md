# Milestone 1 visual matrix

Run the deterministic fixture:

```bash
bun run --cwd apps/desktop visual:dev
```

Open `http://127.0.0.1:1420/tests/visual/`. The page covers:

- Socrates Classic and Pixel 1998 micro icons;
- light and dark surfaces;
- 80%, 100%, 125%, and 150% CSS zoom;
- the decorative sprite at its minimum supported size;
- one interaction target wired to the global particle layer.

Reproduce the 1x/2x captures on macOS with Chrome:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox \
  --force-device-scale-factor=1 \
  --window-size=1200,1800 \
  --screenshot=/tmp/socrates-m1-icons-1x.png \
  http://127.0.0.1:1420/tests/visual/

"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox \
  --force-device-scale-factor=2 \
  --window-size=1200,1800 \
  --screenshot=/tmp/socrates-m1-icons-2x.png \
  http://127.0.0.1:1420/tests/visual/
```

`bun run --cwd apps/desktop test:visual` runs the structural/interaction checks and production build. The screenshots remain an explicit visual review because font and WebView rendering are platform-dependent.
