import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { decimalToAtomic, type GatewayInvocationContext, type GatewayRequest } from "@socrates/core";
import { openDb } from "../db";
import { SessionStore } from "../store/session-store";
import { ModelInvocationBroker } from "./model-invocation-broker";
import { createAiSdkNativeStream } from "../runtime/native-agent-runtime";
import { TaskQuoteService } from "./task-quotes";

const dbs: Database[] = []; afterEach(() => dbs.splice(0).forEach(db => db.close()));
function setup(mode: "soft_limit" | "strict_admission" | "tracking_only" = "soft_limit") {
  const db = openDb(":memory:"); dbs.push(db);
  db.query("INSERT INTO providers(id,name,type,base_url,api_key_ref,created_at,updated_at) VALUES ('p','Fixture','openai_compatible','https://fixture.invalid/v1','unused','now','now')").run();
  const room = new SessionStore(db).create({ mode: "chat", title: "Fixture", primaryAgentId: "a", agents: [{ agentId: "a", snapshot: { providerId: "p", modelId: "fixture-model" }, executionEligible: true }] });
  const broker = new ModelInvocationBroker(db);
  const price = broker.prices.save({ providerConnectionId: "p", modelId: "fixture-model", protocol: "openai_chat_completions", baseUrl: "https://fixture.invalid/v1",
    currency: "USD", rates: { input: "1", output: "1" }, source: "user_confirmed", sourceVersion: "fixture/1" });
  broker.budgets.create({ rootTaskId: "task", roomId: room.id, mode, limitAtomic: decimalToAtomic("1") });
  const invocation: GatewayInvocationContext = { roomId: room.id, rootTaskId: "task", runId: "run", agentId: "a", providerConnectionId: "p", runProfileVersion: "1", logicalStepId: "step", purpose: "respond" };
  const request: GatewayRequest = { providerType: "openai_compatible", baseUrl: "https://fixture.invalid/v1", apiKey: "unused-fixture", modelId: "fixture-model", messages: [{ role: "user", content: "hello" }], maxOutputTokens: 100, invocation };
  return { db, room, broker, invocation, request, price };
}
async function drain<T>(iterable: AsyncIterable<T>) { const result: T[] = []; for await (const event of iterable) result.push(event); return result; }

test("automatic presets settle as estimates, consume the soft budget, freeze per-call prices and become known only after an explicit invoice", async () => {
  const { broker, request, db } = setup();
  db.exec("DELETE FROM cost_price_snapshots");
  const gateway = broker.wrapGateway(async function* () { yield { type: "done", usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, cacheWriteTokens: 0 } }; });
  await drain(gateway(request));
  const first = broker.ledger.list({ rootTaskId: "task" })[0]!;
  expect(first).toMatchObject({ status: "estimated", amount: { atomic: "200000000" } });
  expect(broker.budgets.summary("task")).toMatchObject({ settledKnownAtomic: "0", estimatedAtomic: "200000000", availableAtomic: "999800000000", unresolvedExposureAtomic: "0", unknownCount: 0 });
  broker.prices.save({ providerConnectionId: "p", modelId: request.modelId, protocol: "openai_chat_completions", baseUrl: request.baseUrl,
    rates: { input: "2", output: "10", cacheRead: "2", cacheWrite: "2" }, currency: "USD", source: "user_confirmed", sourceVersion: "custom" });
  await drain(gateway(request));
  expect(broker.ledger.get(first.invocationId)?.priceSnapshotId).toBe(first.priceSnapshotId);
  expect(broker.ledger.summary({ rootTaskId: "task" })).toMatchObject({ totals: [{ atomic: "400000000" }], estimatedTotals: [{ atomic: "200000000" }] });
  broker.ledger.reconcile(first.invocationId, { requestId: "confirmed-bill", totalAtomic: "300000000", currency: "USD", reason: "controlled Provider bill" });
  expect(broker.budgets.summary("task")).toMatchObject({ settledKnownAtomic: "700000000", estimatedAtomic: "0", availableAtomic: "999300000000" });
  db.close();
});

test("an unverified generic preset never establishes a strict monetary bound", async () => {
  const { broker, request, db } = setup("strict_admission");
  db.exec("DELETE FROM cost_price_snapshots"); let calls = 0;
  await expect(drain(broker.wrapGateway(async function* () { calls++; yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }; })(request))).rejects.toThrow("cost_budget_strict_bound_unavailable");
  expect(calls).toBe(0);
  db.close();
});

test("an unbudgeted request gets reasoning headroom while explicit task and request caps remain binding", async () => {
  const { broker, request, db, room } = setup();
  const seen: number[] = [];
  const gateway = broker.wrapGateway(async function* (input) { seen.push(input.maxOutputTokens!); yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }; });
  const invocation = { ...request.invocation!, rootTaskId: "unbudgeted" };
  await drain(gateway({ ...request, maxOutputTokens: undefined, invocation }));
  db.query("INSERT INTO room_commands(id,room_id,client_request_id,fingerprint,input_json,kind,status,created_at,updated_at) VALUES ('unbudgeted',?,'cap','hash',?,'team','running','now','now')")
    .run(room.id, JSON.stringify({ maxOutputTokens: 1024 }));
  await drain(gateway({ ...request, maxOutputTokens: undefined, invocation }));
  await drain(gateway({ ...request, maxOutputTokens: 256, invocation }));
  expect(seen).toEqual([8192, 1024, 256]);
  db.close();
});

test("one physical gateway request prices final usage once despite duplicate finish and preserves request evidence", async () => {
  const { broker, request } = setup(); let calls = 0;
  const gateway = broker.wrapGateway(async function* (input) { calls++; expect(input.maxOutputTokens).toBe(100);
    yield { type: "delta", text: "ok" }; yield { type: "done", usage: { inputTokens: 100, outputTokens: 20 }, requestId: "provider-request" };
    yield { type: "done", usage: { inputTokens: 100, outputTokens: 20 }, requestId: "provider-request" }; });
  await drain(gateway(request));
  expect(calls).toBe(1);
  const facts = broker.ledger.list({ rootTaskId: "task" });
  expect(facts).toHaveLength(1); expect(facts[0]).toMatchObject({ state: "finished", status: "priced", requestId: "provider-request", amount: { atomic: "120000000" } });
  expect(broker.budgets.summary("task")).toMatchObject({ settledKnownAtomic: "120000000", activeReservationsAtomic: "0", unresolvedExposureAtomic: "0" });
});

test("a disconnect after dispatch retains exposure across restart and does not refund unknown usage", async () => {
  const { broker, request, db } = setup();
  await expect(drain(broker.wrapGateway(async function* () { yield { type: "delta", text: "partial" }; throw new TypeError("fetch failed"); })(request))).rejects.toThrow();
  const before = broker.budgets.summary("task");
  expect(before.unknownCount).toBe(1); expect(BigInt(before.unresolvedExposureAtomic)).toBeGreaterThan(0n);
  new ModelInvocationBroker(db).budgets.recoverInterrupted();
  expect(broker.budgets.summary("task").unresolvedExposureAtomic).toBe(before.unresolvedExposureAtomic);
});

test("strict mode rejects an effective user context override before any request or consumption", async () => {
  const { db, broker, request } = setup("strict_admission");
  db.query("UPDATE providers SET base_url='https://api.openai.com/v1' WHERE id='p'").run();
  broker.prices.save({ providerConnectionId: "p", modelId: "fixture-model", protocol: "openai_responses", baseUrl: "https://api.openai.com/v1",
    currency: "USD", rates: { input: "1", output: "1" }, source: "user_confirmed", sourceVersion: "fixture/2" });
  let paidCalls = 0;
  const gateway = broker.wrapGateway(async function* () { paidCalls++; yield { type: "done", usage: { inputTokens: 10, outputTokens: 5 } }; });
  await expect(drain(gateway({ ...request, baseUrl: "https://api.openai.com/v1", invocation: { ...request.invocation!, contextWindowTokens: 1_024 } }))).rejects.toThrow("cost_budget_strict_bound_unavailable");
  expect(paidCalls).toBe(0); expect(broker.ledger.summary({ rootTaskId: "task" }).unknownCount).toBe(0);
  expect(broker.ledger.list({ rootTaskId: "task" })[0]!.state).toBe("not_sent");
});

test("revoking a provider stops the next model sample immediately", async () => {
  const { db, broker, request } = setup(); let calls = 0;
  const gateway = broker.wrapGateway(async function* () { calls++; yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }; });
  await drain(gateway(request)); db.query("UPDATE providers SET enabled=0 WHERE id='p'").run();
  await expect(drain(gateway(request))).rejects.toThrow("invocation_provider_unavailable");
  expect(calls).toBe(1);
});

test("a price change after planning pauses before dispatch and retains the original call's frozen price", async () => {
  const { db, broker, room, request, price } = setup();
  const input = { roomId: room.id, content: "hello", intent: "respond" as const, mentions: [], maxOutputTokens: 100,
    budget: { mode: "soft_limit" as const, limitAtomic: decimalToAtomic("1") } };
  const quote = new TaskQuoteService(db, new SessionStore(db)).quote(input);
  db.query("INSERT INTO room_commands(id,room_id,client_request_id,fingerprint,input_json,kind,status,created_at,updated_at) VALUES ('task',?,'request','hash',?,'direct','running','now','now')")
    .run(room.id, JSON.stringify({ ...input, quoteId: quote.id }));
  let calls = 0;
  const gateway = broker.wrapGateway(async function* () { calls++; yield { type: "done", usage: { inputTokens: 100, outputTokens: 20 } }; });
  await drain(gateway(request));
  broker.prices.save({ ...price, sourceVersion: "changed", rates: { input: "10", output: "20" } });
  await expect(drain(gateway(request))).rejects.toThrow("cost_budget_quote_reprice_required");
  expect(calls).toBe(1);
  const facts = broker.ledger.list({ rootTaskId: "task" });
  expect(facts[0]!.priceSnapshotId).toBe(price.id); expect(facts[0]!.amount?.atomic).toBe("120000000");
  expect(facts[1]!.state).toBe("not_sent");
});

test("strict mode accepts verified official context bounds and keeps output capped", async () => {
  const { db, broker, request } = setup("strict_admission");
  db.query("UPDATE providers SET base_url='https://api.openai.com/v1' WHERE id='p'").run();
  broker.prices.save({ providerConnectionId: "p", modelId: "fixture-model", protocol: "openai_responses", baseUrl: "https://api.openai.com/v1",
    currency: "USD", rates: { input: "1", output: "1" }, source: "user_confirmed", sourceVersion: "fixture-official/1" });
  let paidCalls = 0;
  const gateway = broker.wrapGateway(async function* (req) { paidCalls++; expect(req.maxOutputTokens).toBe(100); yield { type: "done", usage: { inputTokens: 10, outputTokens: 5 } }; });
  await drain(gateway({ ...request, baseUrl: "https://api.openai.com/v1", invocation: { ...request.invocation!, contextWindowTokens: 1_024,
    catalogContextWindow: { tokens: 128_000, providerId: "openai", revision: "verified-fixture" } } }));
  expect(paidCalls).toBe(1); expect(broker.budgets.summary("task").settledKnownAtomic).toBe("15000000");
});

test("a soft child cannot reserve a heuristic amount beneath a strict parent", async () => {
  const { db, broker, request, room } = setup("strict_admission");
  db.query("UPDATE cost_budget_accounts SET limit_atomic='10000000000' WHERE root_task_id='task'").run();
  broker.budgets.create({ rootTaskId: "child", roomId: room.id, mode: "soft_limit", limitAtomic: decimalToAtomic("1"), parentId: "task" });
  db.query("UPDATE providers SET base_url='https://api.openai.com/v1' WHERE id='p'").run();
  broker.prices.save({ providerConnectionId: "p", modelId: "fixture-model", protocol: "openai_responses", baseUrl: "https://api.openai.com/v1",
    currency: "USD", rates: { input: "1", output: "1" }, source: "user_confirmed", sourceVersion: "fixture-official/1" });
  let calls = 0;
  const gateway = broker.wrapGateway(async function* () { calls++; yield { type: "done", usage: { inputTokens: 10, outputTokens: 5 } }; });
  await expect(drain(gateway({ ...request, baseUrl: "https://api.openai.com/v1", invocation: { ...request.invocation!, rootTaskId: "child",
    catalogContextWindow: { tokens: 128_000, providerId: "openai", revision: "verified-fixture" } } }))).rejects.toThrow("cost_budget_insufficient");
  expect(calls).toBe(0);
  expect(broker.budgets.summary("task").settledKnownAtomic).toBe("0");
});

test("untested image billing is rejected by a guarded task and remains unpriced in explicit tracking mode", async () => {
  const guarded = setup(); let calls = 0;
  const payload = { messages: [{ role: "user", content: [{ type: "image", image: "data:image/png;base64,c3ludGhldGlj" }] }] };
  const open = async function* () { calls++; yield { type: "done" as const, usage: { inputTokens: 100, outputTokens: 20 } }; };
  const descriptor = { context: guarded.invocation, providerType: "openai_compatible" as const, baseUrl: guarded.request.baseUrl, modelId: guarded.request.modelId, payload };
  await expect(drain(guarded.broker.invoke(descriptor, open, event => event))).rejects.toThrow("cost_budget_unpriced_modality");
  expect(calls).toBe(0);
  const tracking = setup("tracking_only");
  await drain(tracking.broker.invoke({ ...descriptor, context: tracking.invocation }, open, event => event));
  expect(calls).toBe(1);
  const fact = tracking.broker.ledger.list({ rootTaskId: "task" })[0]!;
  expect(fact.status).toBe("unpriced"); expect(fact.amount).toBeNull();
  expect(fact.unknownItems).toContain("unsupported_input_modality:image");
});

test("native sampling accounts distinct retries and raw unsupported billing dimensions without a second tool loop", async () => {
  const { broker, invocation } = setup(); let calls = 0;
  const stream = createAiSdkNativeStream({} as never, ((options) => {
    calls++; expect(options.maxRetries).toBe(0); expect(options.maxOutputTokens).toBe(100);
    const attempt = calls;
    return { fullStream: (async function* () {
      if (attempt === 1) { yield { type: "error", error: { statusCode: 429, headers: { "retry-after": "0" } } }; return; }
      yield { type: "text-delta", text: "done" };
      yield { type: "raw", rawValue: { type: "response.completed", response: { service_tier: "priority", usage: { input_tokens: 100, output_tokens: 20 } } } };
      yield { type: "finish", totalUsage: { inputTokens: 100, outputTokens: 20 }, finishReason: "stop" };
    })(), response: Promise.resolve({ id: "req-2" }), responseMessages: Promise.resolve([]), steps: Promise.resolve([{}]) } as never;
  }) as typeof import("ai").streamText, { providerType: "openai_compatible", modelId: "fixture-model", baseUrl: "https://fixture.invalid/v1", maxOutputTokens: 100,
    broker, invocation });
  await drain(stream({ prompt: "work", messages: [], tools: {}, maxSteps: 1, requestApproval: async () => ({ approved: false }) }));
  expect(calls).toBe(2);
  const facts = broker.ledger.list({ rootTaskId: "task" });
  expect(facts).toHaveLength(2); expect(facts.map(fact => fact.attemptNo)).toEqual([1, 2]);
  expect(facts[0]!.state).toBe("outcome_unknown");
  expect(facts[1]!.status).toBe("partially_priced");
  expect(facts[1]!.unknownItems).toContain("openai_service_tier:priority");
});
