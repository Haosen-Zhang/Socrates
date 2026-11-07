# P00 cost-aware reuse decisions and executable evidence

Recorded on 2026-11-06 against the current code, not the prompt's old Alpha.1 commit. No paid Provider call, production credential, cloud account, private upload or production database was used.

## Component decisions

| Capability | Decision | Frozen version/license | Actual integration/evidence |
|---|---|---|---|
| Official OpenAI protocol | `direct_dependency` | `@ai-sdk/openai` 4.0.10, Apache-2.0 | `gateway-aisdk.ts` selects official Responses adapter for the exact official HTTPS connection; both Gateway and Native use `createAiSdkModel` and `invocationModelOptions`. Fetch contract fixtures execute the SDK serializer/parser and a function tool with stable call ID. |
| Generic proxies / Anthropic | Existing `direct_dependency` | `@ai-sdk/openai-compatible` 3.0.6 / `@ai-sdk/anthropic` 4.0.10, Apache-2.0 | Existing compatible and Anthropic adapters remain. A model named GPT on a proxy does not silently acquire an official protocol or price identity. |
| Price catalog | `data_reuse` | models.dev, MIT; source commit observed `c464e18c362617bfb7321188637d4c92358ca54b` | Real public generated API subset in `services/fixtures/models-dev-frozen.json`, used by `PricingStore`. Adjacent provenance and license preserve source/date/full and subset hashes. It is not a fabricated synthetic catalog. |
| Graph control flow | `direct_dependency` + `adapter` | Existing `@langchain/langgraph` 0.2.74 and checkpoint 0.0.18, MIT | `services/reuse/langgraph-workflow.ts` calls the actual `RoomCommandService`, interrupts for a human decision and resumes in another Bun process. `BunSqliteCheckpointSaver` implements only the storage interface; LangGraph supplies graph execution, interrupt semantics, IDs and serialization. |
| Official SQLite saver | `reference_only` after reproduced incompatibility | `@langchain/langgraph-checkpoint-sqlite` 0.1.5, MIT | Matching peer ranges require `better-sqlite3` 11.x; its install on this Node 26/macOS arm64 host failed native compilation. It is not an installed shipping dependency. The alternate Bun adapter is tested with the actual graph and process restart. |
| Local spans | `direct_dependency` | `@opentelemetry/api` 1.9.0 and `sdk-trace-base` 2.6.0, Apache-2.0 | `LocalServiceTracer` creates actual SDK spans from committed service events. The broker calls `recordServiceEvent`; exporter is absent by default, environment exporter variables are ignored, payload is never forwarded. Tests inspect spans using the SDK's in-memory exporter. |
| Langfuse export | `reference_only` | No SDK added | No cloud export is enabled or claimed. A future explicitly enabled exporter should consume the same OTel spans after authorization and masking; business facts remain local. |
| Full-task evaluation interface | `adapter` | promptfoo 0.125.1, MIT, isolated `scripts/reuse` development package | `SocratesTaskProvider` submits a whole controlled room task, awaits persisted lifecycle, reads resulting public history and task usage. An actual promptfoo `evaluate()` run executes a deterministic assertion and returns usage. It does not call a bare model. |
| Chat components | Existing UI retained; assistant-ui `reference_only` | No new dependency | P00-P02 add cost controls to existing React/Zustand RoomComposer/Provider panels; a chat-stack migration solves no missing cost behavior. |
| Retrieval/schema/diff | Existing dependencies retained | Bun SQLite FTS5; existing Zod 4; existing diff UI | FTS5 compatibility test runs a real query with project filtering in temporary SQLite. Price schema validation uses existing Zod. Existing diff components are not replaced. P06 project-memory governance is outside this run. |
| Money, price binding, budget policy | `custom_domain_logic` | Socrates-owned | Business-specific integer money, exact connection identity, immutable ledger, authorization and atomic aggregate admission remain Socrates services. |

## OpenAI protocol and capability contract

Primary sources fetched during implementation:

- [GPT-6.1 Sol model](https://developers.openai.com/api/docs/models/gpt-6.1-sol): tools require Responses; reasoning efforts are low/medium/high/xhigh/max.
- [GPT-6 parameter guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6.1-sol): unsupported `none`/`minimal` on Sol; omit temperature when reasoning is enabled.
- [AI SDK OpenAI provider source](https://github.com/vercel/ai/tree/main/packages/openai): official provider handles serialization, streaming and function-tool IDs. This integration uses the installed 4.0.10 source, not assumptions about latest.

`modelProtocol` returns canonical protocol names `openai_responses`, `openai_chat_completions`, `anthropic_messages`. Selection requires `https://api.openai.com/v1` with no credentials or alternate port; names and model brands do not override a proxy connection. OpenAI requests use `store:false`. Every SDK invocation has `maxRetries:0`; Socrates owns observable retries.

GPT-6 is absent from this compatible SDK release's static reasoning allowlist, so `invocationModelOptions` uses its documented `forceReasoning:true` provider option after local model validation. Contract tests inspect the actual final request and confirm reasoning effort/output cap are serialized and temperature omitted. Disabled/minimal Sol reasoning is rejected before fetch. No extra SDK Agent loop wraps Native.

The original test fixture failed at `/chat/completions`; after integration it passes at `/responses`. A function-call fixture passes through the real provider and SDK execution seam, preserving `call_stable` and the structured tool input. This validates the protocol adapter locally, not account entitlements or a live model result.

The compatible 4.0.10 OpenAI adapter's normalized schema strips newer OpenAI cache-write details. The integration uses the SDK's supported `includeRawChunks` seam to extract only terminal numeric usage fields before stripping, then discards the raw chunk. A contract fixture confirms `cache_write_tokens` reaches the final usage without upgrading the whole AI SDK stack or parsing HTTP separately. [OpenAI's caching contract](https://developers.openai.com/api/docs/guides/prompt-caching) defines input as including read/write subsets; 30-minute writes use 1.25× input rate, while 12-hour writes use 2.5×. Mixed-lifetime writes and nonstandard returned service tiers are flagged as unsupported billing dimensions rather than silently applying the default rate. Missing dimensions remain incomplete, never manufactured as zero. Anthropic's SDK normalizes its disjoint uncached/read/write fields into an inclusive input total before the cost service sees them. A future SDK upgrade must retest both protocol types and all billing adapters.

## LangGraph persistence and cancellation

Primary sources: [persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence), [interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts), installed checkpoint/SQLite saver source.

The compatibility workflow has owner ID `reuse:<roomId>:cost-aware-compatibility-v1` and graph version `cost-aware-compatibility-v1`. It is an executable compatibility workflow, not a registered second owner of production team scheduling. Future P04 adaptive workflows can use this adapter; existing Native and TeamRunner ownership remains authoritative in P00-P02.

Checkpoint storage is explicitly separate from task/ledger truth. `lg_checkpoints` and `lg_writes` are created only in the adapter's supplied database; production startup does not instantiate the compatibility graph. Pending writes, parents, namespaces and serializer types are retained. Caller-supplied metadata filter names never enter SQL. Only trusted local checkpoint data is deserialized; external checkpoint import is not exposed.

Executed proof:

1. Child Bun process creates temporary Socrates services and a real Chat discussion task with controlled model stream, writes the public result, and reaches a persisted interrupt.
2. Process exits and closes SQLite.
3. Another Bun process opens the same database, resumes with LangGraph `Command`, reaches approval, and observes only one persisted model-service dispatch.
4. Repeated resume reads the finished checkpoint and does not dispatch again.
5. Pre-abort causes no service invocation. A separate in-flight abort propagates through actual `RoomCommandService.cancel`; its durable task becomes cancelled and human review does not complete.

The task's stable request identity provides service idempotency even if a graph node is retried around an application checkpoint. Unknown remote outcomes are never resolved by replaying a graph checkpoint.

Reproduced official-saver blocker:

```sh
# Execute only in a disposable compatibility package; not needed to run Socrates.
bun add --exact @langchain/langgraph-checkpoint-sqlite@0.1.5
```

On Bun 1.3.14 with install scripts using Node 26.0.0/darwin arm64, `better-sqlite3` 11.10.0 had no prebuilt binary and failed C++ compilation (`v8::Object` has no member `GetPrototype`; `v8::PropertyCallbackInfo` has no member `This`). This is a host/native-addon compatibility failure, not a Socrates task-state failure. A newer saver requires a graph/core generation migration; this run instead reuses the existing graph and its standard checkpoint interface with Bun's already-shipped SQLite.

## Offline observation and evaluation

[OpenTelemetry JS instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/) defines the SDK/provider/span/exporter seams used here. The local tracer allowlists only event ID, room ID, task ID and event sequence. It does not include prompt text, file content, API keys, private reasoning or arbitrary payloads. Tests inject a real SDK in-memory exporter; production constructs no exporter and never discovers one from environment settings.

[promptfoo custom JavaScript providers](https://www.promptfoo.dev/docs/providers/custom-api/) defines `id()`/`callApi()`. `SocratesTaskProvider` uses that interface to execute the full existing Chat task lifecycle. It reports actual task tokens only when complete. It does not claim P07 Arena isolation, Work trial metrics, verification success or savings.

To rerun the actual promptfoo integration:

```sh
bun install --cwd scripts/reuse --ignore-scripts
bun run --cwd scripts/reuse promptfoo
```

The experiment disables telemetry, update checks, sharing and remote generation before importing promptfoo. It sets a temporary config/database directory and replaces network fetch with a throwing guard. Deterministic local `equals` assertion is used; no paid grader is selected. The experiment package is outside desktop runtime dependencies.

Observed promptfoo output: library 0.125.1, successes 1, failures 0, taskCommands 1, prompt/completion/total usage 10/5/15, network forbidden, temporary-only persistence, sharing false. This is an interface/compatibility result using synthetic model output, not economic performance evidence.

## Repeatable local checks

```sh
bun test packages/core/src/model-capabilities.test.ts apps/sidecar/src/gateway-aisdk.test.ts apps/sidecar/src/services/reuse
bun run --cwd scripts/reuse promptfoo
bun run typecheck
```

Gateway, GPT-6 capabilities and reuse checks passed 19 tests / 0 failures after the raw cache-write and FTS5 cases were added. No live OpenAI/Anthropic/custom Provider request was verified. Runtime/tool permissions, quotes, money, budgets and production pause/resume are separately tested through the owning Socrates services; passing these compatibility spikes alone does not establish P01/P02 acceptance.

The 2026-11-07 pricing follow-up retains the actual frozen models.dev import and custom-override path. It additionally uses verified official public billing facts as a versioned offline reference for the user's configured OpenAI/DeepSeek models, with an explicitly estimated preset for other connections/models. This is called by the existing production quote/broker/ledger services and exercised through real HTTP/browser flows; it is not a second pricing gateway or an installed-only adapter. Current coverage, sources and limits are in [automatic-model-pricing.md](automatic-model-pricing.md).
