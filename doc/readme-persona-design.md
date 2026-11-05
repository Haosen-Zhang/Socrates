# README and persona identity design

User request: an English-first, bilingual product README that makes multi-model
Chat, multi-agent Work, and custom AI characters immediately understandable;
many English/Chinese random names, distinctive generated avatars, and uploads.

## Direction

Use an editorial dark pixel-art identity: oversized typography, warm ivory,
electric lime, and actual application views. GitHub supports neither arbitrary
page CSS nor a JavaScript language toggle, so English `README.md` and
`README.zh-CN.md` link to each other at the top. Local SVG artwork supplies the
visual composition; screenshots show the real React interface with explicitly
labelled demonstration data. Text remains accessible outside images.

A text-only README would undersell the interface. A standalone promotional
website would add deployment and duplicate the requested surface. The chosen
approach stays portable in GitHub, local Markdown viewers, and repository forks.

## Identity

- Compose 32 prefixes with 64 nouns per language (2,048 base names each).
  Offer English, Simplified Chinese and Traditional Chinese; start in app language.
- Keep normalized-name collision handling, with suffixes after exhausting a pool.
- Store versioned generated-avatar seeds, not arbitrary SVG. Render an internal
  seven-by-seven symmetric pixel pattern using fixed accessible colour palettes.
  Vary shape as well as hue; generate locally without dependencies or network.
- Keep legacy fallback identities stable, existing bundled portraits, and raster
  uploads up to 2 MB. Changing a name preserves the avatar and vice versa.
- Give generated choices and uploads labelled, keyboard-operable controls.

## Verification

Test deterministic identities, language pools and exhaustion, visual diversity,
strict avatar-source validation, API persistence, and legacy compatibility.
Exercise creation, editing, independent shuffles, uploads and errors in Chrome;
inspect README images and the editor at normal and compact widths. Run all three
repository gates. Promotional claims must match current runtime capabilities;
no claim of parallel shared-workspace writes or shipping LangGraph governance.
