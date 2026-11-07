# Automatic model prices and reference estimates

Verified 2026-11-07. Normal use requires no per-call bill entry.

## API capability and the implemented default

The [OpenAI model object](https://developers.openai.com/api/reference/resources/models) and [DeepSeek model list](https://api-docs.deepseek.com/api/list-models/) do not publish unit rates in their documented model-list response. OpenAI's [organization costs API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs) is a separate administrative billing API, not a standard per-request price lookup. Some services, such as [OpenRouter's model API](https://openrouter.ai/docs/api/api-reference/models/get-model), do publish pricing metadata. There is no universal compatible endpoint for it.

Socrates now resolves each connection/model locally, using this order:

1. User-confirmed, connection-specific model override.
2. Bundled official reference rules for an exact official endpoint/protocol/model.
3. An existing verified catalog mapping.
4. An explicitly estimated preset for unlisted models and unverified proxies.

`automatic-pricing.ts` contains versioned public billing facts and their URLs, not an inference call or runtime HTML scraper. Current verified coverage includes GPT-6 Astra, GPT-6.1 Sol/Terra, GPT-6 Luna, GPT-5.6 Luna, DeepSeek Flash and V4 Pro. The documented legacy Flash aliases map to current Flash rules. OpenAI reference data includes cache reads/writes and the >272K-input tier. DeepSeek chooses UTC peak/off-peak windows; peak references do not pretend to apply an unverified Chinese holiday calendar. Official reference amounts remain labelled estimates rather than confirmed invoices.

Sources: [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [DeepSeek prices](https://api-docs.deepseek.com/quick_start/pricing/). The bundle records its verification timestamp and expiry. No message waits for an online price download. This change does not add a live OpenRouter catalog adapter or automatic organization-bill download.

Unlisted models start with an editable USD reference preset of 1 / 5 per million input/output tokens; its cache reference rates are 1. For a known OpenAI model on an unverified proxy, the matching public model rate is only a proxy reference estimate, not a claim about that proxy's actual invoice. The Providers form prefills the applicable rate, shows source/date and allows one override per model. An override applies to future calls; it does not rewrite a previously frozen invocation price.

## Accounting and budgets

Provider usage remains the quantity evidence. All money and tier multiplication use decimal strings and bigint arithmetic. Preset/reference prices produce `estimated` amounts. Known totals and estimated totals are separate. Soft-budget availability subtracts both known and booked estimated consumption; an estimate does not become a missing-execution outcome or require a per-call invoice. Strict admission never accepts an unverified preset as a proven bound. Partial usage, unsupported billing dimensions, currency restrictions and uncertain remote outcomes retain their safeguards.

For a historical finished call that stored usage but no price, the view adds `referenceEstimate`, bound to a current immutable reference snapshot. The original status, amount, price snapshot, usage and timestamps remain unchanged. This is a current-reference view, not a historical invoice or a durable revaluation fact. Historical view estimates do not release old unresolved budget reservations. CSV/JSON exports retain original fields and explicitly separate reference estimate fields/versions.

The UI separates estimates, missing prices, partial billing information and uncertain outcomes. Ordinary reference-priced calls do not show per-invocation bill forms. Genuine missing/uncertain usage still supports explicit manual invoice reconciliation. No synthetic examples or estimates are presented as confirmed Provider bills.

## Evidence and limits

- Production quote/broker/ledger/routes integration: automatic defaults, current-reference history, separate exports, one model-wide override, next-call application and immutable past charges.
- Soft-budget estimate consumption and explicit invoice conversion without double counting; strict rejection of unverified presets.
- Real Chrome: automatic amount, no per-call bill forms, prefilled official model rates, one override, separate exports and preserved history/frozen charges.
- An isolated consistent copy of the user's database projects reference estimates for all 26 observed calls. All 15 protected table hashes remain unchanged; the actual database was opened read-only.

Further verified provider coverage, live catalog refresh, exact holiday calendars and administrative bill sync remain future work. No paid model, real credential, private upload or production database mutation is used for these checks. See [implementation-progress.md](../implementation-progress.md) and `output/validation/automatic-pricing/` for final gates.
