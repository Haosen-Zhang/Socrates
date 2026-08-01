# Notes: Model-aware reasoning effort selection

## Existing pipeline

- The desktop previously asked users to declare a capability checkbox list and
  then choose a second default value from it.
- The Agent API trusted that client-provided list and only forwarded effort for
  OpenAI-compatible Providers.
- `reasoning_effort` is already nullable in SQLite, so legacy rows can be
  normalized to `auto` without a schema migration.

## Capability policy

- `auto` omits Provider options and keeps the Provider/model default.
- DeepSeek exposes `auto`, `disabled`, `high`, and `max`.
- GPT-5/o-series exposes `auto`, `disabled`, `low`, `medium`, `high`, and `xhigh`;
  non-reasoning GPT models do not inherit those levels.
- Claude, Gemini, Qwen, Kimi, GLM, Grok, Llama, and Mistral use model-family
  profiles. Unknown/custom deployments fall back to `auto/disabled` and retain
  an existing explicit capability override while their model remains unchanged.
- Model IDs may include registry/vendor prefixes such as `openai/gpt-5.4`.

## Runtime mapping

- OpenAI-compatible GPT disabled maps to `reasoningEffort: none`.
- DeepSeek maps its thinking toggle and effort in the compatible request body.
- Qwen/Kimi/GLM use `enable_thinking`; Anthropic uses its native effort option.
- Server-side Agent validation derives the same profile and rejects unsupported
  values, so a hand-written request cannot bypass the UI.
- Review found and fixed a PUT compatibility bug: resubmitting an unchanged
  provider/model no longer resets a supported effort, while an actual model
  change or stale unsupported stored value safely normalizes to `auto`.

## Verification evidence

- Focused core, Agent route, gateway, and SSR component tests passed.
- Full `bun test`: 505 passed, 2 platform-conditional skips, 0 failed.
- Typecheck and lint passed.
- Desktop production build passed with existing Vite chunk warnings only.
- Isolated Tauri smoke on port 1423 showed one required DeepSeek dropdown at
  900x700; the duplicate capability row is gone and the modal remains scrollable.
- The gateway integration test drains an AI SDK SSE response and asserts the
  actual serialized DeepSeek HTTP body, including its thinking and effort fields.
