# README and persona identity acceptance

Verified on 2026-11-06, based on main commit `79f934b`.

## Delivered

- Default English `README.md` and linked `README.zh-CN.md`, with six localized
  SVG illustrations and three real application captures. Both explain Chat,
  Work and custom characters; the captures explicitly use demonstration data.
- 2,048 unique base names per language: English, Simplified Chinese and
  Traditional Chinese. Normalized duplicates are skipped; suffixes handle pool
  exhaustion.
- Locally generated, versioned pixel-avatar seeds. Shapes and colours vary;
  every sampled avatar in a deterministic set of 2,048 was distinct, including
  more than 2,040 distinct silhouettes with colours removed.
- Independent name and avatar controls, 12 generated choices per batch, the
  six existing portraits, and raster uploads up to 2 MB. Old fallback identities
  and saved avatar sources are preserved.
- Uploaded files must decode as images before being saved. A stale upload cannot
  replace a newer selection; editing starts with the saved identity immediately.

## Verification

| Check | Result |
| --- | --- |
| `bun test` on the macOS host | 885 passed, 0 failed, 157 files |
| `bun run typecheck` | Passed |
| `bun run --cwd apps/desktop build` | Passed |
| Changed TypeScript/TSX Biome lint | 9 files passed |
| Browser identity workflow | 22 checks passed; no page exceptions |
| README render | English and Chinese at 1180 px and 390 px; all images loaded, no page overflow |
| README local resources | 17 links per language resolved; language switch and return worked |

The browser workflow covers independent shuffles; all three name languages;
classic portraits; SVG, oversized and corrupt-file rejection; valid uploads;
duplicate-name protection; saved upload and generated-seed persistence; reopening
the editor; delayed-upload cancellation; image decoding; and a 760 px desktop
layout. It also captures the real Work plan-approval UI.

GitHub's Markdown API rendered both pages; that HTML was inspected in local
desktop and narrow previews. Art and capture reproduction instructions are in
[the asset guide](assets/readme/README.md). Existing bundle-size and mixed-import
Vite warnings remain. No new runtime dependencies were added.

This verification uses Chrome, the actual React UI, an isolated sidecar and
scripted model responses. It does not claim a live-provider test or a native
Tauri-window test.
