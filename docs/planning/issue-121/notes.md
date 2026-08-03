# CAT-001 implementation notes

- Catalog source defaults to `https://models.opencode.ai/api.json` and can be
  replaced with `SOCRATES_MODEL_CATALOG_URL`.
- Cache lives under Socrates app data, stores SHA-256/ETag/fetch time/revision,
  and permits verified stale reads when refresh fails.
- Provider mapping is explicit `catalogProviderId` or one exact, unique API URL
  match; model-name similarity is never used.
- The renderer displays the catalog effective value but sends `userOverride:
  null` until the user edits it.
- Unknown limits use an unbounded first-stage context path and remain
  unavailable; Provider overflow is surfaced instead of guessing a capacity.
