import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db";
import { runMigrations } from "../store/migrations";
import { migrations } from "../store/migrations/index";
import { decimalToAtomic, type InvocationIdentity, type PriceInput } from "@socrates/core";
import { CostLedger, BudgetLedger } from "./cost-ledger";
import { PricingStore } from "./pricing-store";

const dbs: Database[] = [], roots: string[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(path = ":memory:") { const db = openDb(path); dbs.push(db); return { db, pricing: new PricingStore(db), ledger: new CostLedger(db), budget: new BudgetLedger(db) }; }
const identity = (id: string, rootTaskId = "task"): InvocationIdentity => ({ invocationId: id, logicalStepId: `step:${id}`, attemptNo: 1, roomId: "room", rootTaskId, runId: `run:${id}`, agentId: "agent", purpose: "execute", providerConnectionId: "p", modelId: "m", runProfileVersion: "profile:1", traceId: "trace", spanId: id });
const input: PriceInput = { providerConnectionId: "p", modelId: "m", protocol: "chat_completions", baseUrl: "https://fixture.invalid/v1", upstreamProvider: "fixture", currency: "USD", rates: { input: "0.5", output: "2", cacheRead: "0.1", cacheWrite: "0.75" }, source: "user_confirmed", sourceVersion: "test:1", sourceUrl: "local:user", billingMode: "metered" };

describe("immutable invocation costs", () => {
  it("shows a separate current reference estimate for an old unpriced call without rewriting its stored accounting facts", () => {
    const { db, ledger, pricing } = setup();
    db.query("INSERT INTO providers(id,name,type,base_url,api_key_ref,created_at,updated_at) VALUES ('p','Official','openai_compatible','https://api.openai.com/v1','unused','now','now')").run();
    ledger.begin({ ...identity("historical"), modelId: "gpt-6-luna" }, null); ledger.markSent("historical");
    ledger.finish("historical", { usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 1000 } });
    const before = db.query("SELECT * FROM cost_invocations WHERE id='historical'").get();
    expect(ledger.get("historical")).toMatchObject({ status: "unpriced", amount: null, priceSnapshotId: null,
      referenceEstimate: { amount: { atomic: "175000000" }, reason: "historical_current_reference" } });
    expect(ledger.summary()).toMatchObject({ totals: [], estimatedTotals: [{ atomic: "175000000" }], outcomeUnknownCount: 0, unpricedCount: 0, estimatedCount: 1 });
    pricing.save({ providerConnectionId: "p", modelId: "gpt-6-luna", protocol: "openai_responses", baseUrl: "https://api.openai.com/v1", rates: { input: "1", output: "2", cacheRead: "1", cacheWrite: "1" }, currency: "USD", source: "user_confirmed", sourceVersion: "adjust" });
    expect(ledger.get("historical")?.referenceEstimate?.amount.atomic).toBe("1200000000");
    expect(db.query("SELECT * FROM cost_invocations WHERE id='historical'").get()).toEqual(before);
  });
  it("keeps expired offline prices visible but excludes inapplicable rates from known consumption", () => {
    const { ledger, pricing } = setup(); const expired = pricing.save({ ...input, validFrom: "2025-01-01T00:00:00Z", validUntil: "2025-02-01T00:00:00Z" });
    ledger.begin(identity("expired"), expired.id); ledger.markSent("expired"); ledger.finish("expired", { usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0 } });
    expect(ledger.get("expired")).toMatchObject({ status: "unpriced", priceSnapshotId: expired.id, amount: null, unknownItems: ["price_snapshot_expired"] });
    expect(ledger.summary({ rootTaskId: "task" })).toMatchObject({ unknownCount: 1, totals: [] });
  });
  it("uses the request start tariff even when the response finishes outside its applicable interval", () => {
    const { db, ledger, pricing } = setup(); const price = pricing.save({ ...input, validFrom: "2025-01-01T00:00:00Z", validUntil: "2025-02-01T00:00:00Z" });
    ledger.begin(identity("crossing-time"), price.id);
    db.query("UPDATE cost_invocations SET created_at='2025-01-15T00:00:00.000Z' WHERE id='crossing-time'").run();
    ledger.markSent("crossing-time"); ledger.finish("crossing-time", { usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0 } });
    expect(ledger.get("crossing-time")).toMatchObject({ status: "priced", amount: { atomic: "70000000" } });
  });
  it("keeps one charge on duplicate final and preserves the bound historical price", () => {
    const { ledger, pricing } = setup(); const snapshot = pricing.save(input);
    ledger.begin(identity("i1"), snapshot.id); ledger.markSent("i1", "request-1");
    const usage = { inputTokens: 10000, cachedInputTokens: 3000, cacheWriteTokens: 1000, outputTokens: 2000, reasoningTokens: 500 };
    ledger.finish("i1", { usage }); ledger.finish("i1", { usage });
    pricing.save({ ...input, rates: { input: "99", output: "99" }, sourceVersion: "test:2" });
    expect(ledger.summary({ rootTaskId: "task" })).toMatchObject({ invocations: 1, unknownCount: 0, totals: [{ currency: "USD", atomic: "8050000000", scale: 12 }] });
    expect(ledger.get("i1")).toMatchObject({ requestId: "request-1", priceSnapshotId: snapshot.id, status: "priced" });
    expect(ledger.get("i1")?.usage).toEqual(usage);
  });
  it("keeps independent retry costs and separates currencies and unknown outcomes", () => {
    const { ledger, pricing } = setup(); const usd = pricing.save(input), eur = pricing.save({ ...input, currency: "EUR" });
    ledger.begin(identity("a"), usd.id); ledger.markSent("a"); ledger.finish("a", { usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0 } });
    ledger.begin({ ...identity("b"), attemptNo: 2, logicalStepId: "step:a" }, eur.id); ledger.markSent("b"); ledger.finish("b", { usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0 } });
    ledger.begin(identity("c"), usd.id); ledger.markSent("c"); ledger.markUnknown("c");
    expect(ledger.summary({ roomId: "room" })).toMatchObject({ invocations: 3, unknownCount: 1, totals: [{ currency: "EUR", atomic: "70000000", scale: 12 }, { currency: "USD", atomic: "70000000", scale: 12 }] });
  });
  it("retains only billable usage evidence instead of arbitrary provider private fields", () => {
    const { ledger, pricing } = setup(); ledger.begin(identity("private"), pricing.save(input).id); ledger.markSent("private");
    ledger.finish("private", { usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, ...{ apiKey: "DO_NOT_PERSIST", reasoningContent: "private chain", responseBody: "private text" } } });
    expect(ledger.get("private")?.usage).toEqual({ inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0 });
  });
  it("does not remove consumed facts when room messages or task projections are removed", () => {
    const { db, ledger, pricing } = setup(); ledger.begin(identity("persist"), pricing.save(input).id); ledger.markSent("persist"); ledger.finish("persist", { usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0 } });
    db.query("DELETE FROM room_commands WHERE room_id=?").run("room"); db.query("DELETE FROM sessions WHERE id=?").run("room");
    expect(ledger.get("persist")?.amount?.atomic).toBe("70000000");
  });
  it("records explicit invoice adjustment without rewriting the original usage price", () => {
    const { ledger, pricing } = setup(); ledger.begin(identity("adjust"), pricing.save(input).id); ledger.markSent("adjust"); ledger.finish("adjust", { usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0 } });
    ledger.adjust("adjust", { requestId: "invoice-1", amountAtomic: "1000000", currency: "USD", reason: "invoice correction" });
    ledger.adjust("adjust", { requestId: "invoice-1", amountAtomic: "1000000", currency: "USD", reason: "invoice correction" });
    expect(ledger.get("adjust")?.amount?.atomic).toBe("70000000");
    expect(ledger.summary({ rootTaskId: "task" }).totals[0]?.atomic).toBe("71000000");
  });
  it("settles an unknown invoice explicitly without rewriting the original missing-usage fact", () => {
    const { ledger, pricing, budget } = setup(); budget.create({ rootTaskId: "task", roomId: "room", mode: "soft_limit", limitAtomic: decimalToAtomic("1") });
    ledger.begin(identity("unknown-invoice"), pricing.save(input).id); budget.reserve("unknown-invoice", "task", decimalToAtomic("0.25"), { strictEligible: true }); ledger.markSent("unknown-invoice"); ledger.markUnknown("unknown-invoice");
    const invoice = { requestId: "invoice-known", totalAtomic: decimalToAtomic("0.10"), currency: "USD", reason: "Provider invoice reconciled" };
    ledger.reconcile("unknown-invoice", invoice); ledger.reconcile("unknown-invoice", invoice);
    expect(ledger.get("unknown-invoice")).toMatchObject({ usage: null, status: "outcome_unknown", reconciliation: { amount: { atomic: decimalToAtomic("0.10") } } });
    expect(budget.summary("task")).toMatchObject({ settledKnownAtomic: decimalToAtomic("0.10"), unresolvedExposureAtomic: "0", unknownCount: 0, availableAtomic: decimalToAtomic("0.90") });
    ledger.finish("unknown-invoice", { usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0 } });
    expect(budget.summary("task").settledKnownAtomic).toBe(decimalToAtomic("0.10"));
  });
  it("does not release a USD parent's exposure through a foreign-currency reconciliation", () => {
    const { ledger, pricing, budget } = setup();
    budget.create({ rootTaskId: "parent", roomId: "room", mode: "soft_limit", limitAtomic: decimalToAtomic("1") });
    budget.create({ rootTaskId: "task", roomId: "room", mode: "tracking_only", limitAtomic: "0", parentId: "parent" });
    ledger.begin(identity("fx-unknown"), pricing.save(input).id); budget.reserve("fx-unknown", "task", decimalToAtomic("0.25"), { strictEligible: true }); ledger.markSent("fx-unknown"); ledger.markUnknown("fx-unknown");
    expect(() => ledger.reconcile("fx-unknown", { requestId: "invoice-eur", totalAtomic: decimalToAtomic("0.10"), currency: "EUR", reason: "Foreign invoice" })).toThrow("cost_budget_currency_unsupported");
    expect(budget.summary("parent")).toMatchObject({ settledKnownAtomic: "0", unresolvedExposureAtomic: decimalToAtomic("0.25"), unknownCount: 1 });
    expect(ledger.get("fx-unknown")?.reconciliation).toBeUndefined();
    ledger.reconcile("fx-unknown", { requestId: "invoice-usd", totalAtomic: decimalToAtomic("0.10"), currency: "USD", reason: "USD invoice" });
    expect(budget.summary("parent")).toMatchObject({ settledKnownAtomic: decimalToAtomic("0.10"), unresolvedExposureAtomic: "0", unknownCount: 0 });
  });
  it("keeps separate invoice currencies available for explicit tracking-only accounts", () => {
    const { ledger, pricing, budget } = setup(); budget.create({ rootTaskId: "task", roomId: "room", mode: "tracking_only", limitAtomic: "0" });
    ledger.begin(identity("fx-tracking"), pricing.save(input).id); ledger.markSent("fx-tracking"); ledger.markUnknown("fx-tracking");
    ledger.reconcile("fx-tracking", { requestId: "foreign-tracking", totalAtomic: decimalToAtomic("0.10"), currency: "EUR", reason: "Explicit foreign invoice" });
    expect(ledger.summary({ rootTaskId: "task" })).toMatchObject({ unknownCount: 0, totals: [{ currency: "EUR", atomic: decimalToAtomic("0.10"), scale: 12 }] });
  });
});

describe("atomic task budgets", () => {
  it("refuses T02: settled .60 plus .25 reserved leaves too little for .20", () => {
    const { ledger, pricing, budget } = setup(); const price = pricing.save({ ...input, rates: { input: "1000000", output: "0" }, explicitlyFree: true });
    budget.create({ rootTaskId: "task", roomId: "room", mode: "soft_limit", limitAtomic: decimalToAtomic("1") });
    ledger.begin(identity("s"), price.id); budget.reserve("s", "task", decimalToAtomic("0.60"), { strictEligible: true }); ledger.markSent("s");
    ledger.finish("s", { usage: { inputTokens: 0, outputTokens: 0 } }); ledger.adjust("s", { requestId: "actual", amountAtomic: decimalToAtomic("0.60"), currency: "USD", reason: "fixture actual" });
    ledger.begin(identity("r"), price.id); budget.reserve("r", "task", decimalToAtomic("0.25"), { strictEligible: true });
    ledger.begin(identity("n"), price.id);
    expect(() => budget.reserve("n", "task", decimalToAtomic("0.20"), { strictEligible: true })).toThrow("budget_insufficient");
    expect(budget.summary("task")).toMatchObject({ settledKnownAtomic: decimalToAtomic("0.60"), activeReservationsAtomic: decimalToAtomic("0.25"), availableAtomic: decimalToAtomic("0.15") });
  });
  it("admits at most one concurrent .60 request into a $1 parent and does not double count child consumption", async () => {
    const { ledger, pricing, budget } = setup(); const p = pricing.save(input);
    budget.create({ rootTaskId: "parent", roomId: "room", mode: "soft_limit", limitAtomic: decimalToAtomic("1") });
    for (const task of ["child1", "child2"]) { budget.create({ rootTaskId: task, roomId: "room", mode: "soft_limit", limitAtomic: decimalToAtomic("1"), parentId: "parent" }); ledger.begin(identity(task, task), p.id); }
    const admitted = await Promise.allSettled(["child1", "child2"].map(task => Promise.resolve().then(() => budget.reserve(task, task, decimalToAtomic("0.60"), { strictEligible: true }))));
    expect(admitted.filter(result => result.status === "fulfilled")).toHaveLength(1);
    ledger.markSent("child1"); ledger.finish("child1", { usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0 } });
    expect(budget.summary("parent").settledKnownAtomic).toBe("70000000");
    expect(ledger.summary({ roomId: "room" }).totals[0]?.atomic).toBe("70000000");
  });
  it("keeps sent outcomes unresolved across restart while releasing proven-unsent reservations", () => {
    const root = mkdtempSync(join(tmpdir(), "socrates-cost-restart-")); roots.push(root); const path = join(root, "cost.db");
    const { db, pricing, ledger, budget } = setup(path), p = pricing.save(input);
    budget.create({ rootTaskId: "task", roomId: "room", mode: "soft_limit", limitAtomic: decimalToAtomic("1") });
    for (const id of ["sent", "unsent"]) { ledger.begin(identity(id), p.id); budget.reserve(id, "task", decimalToAtomic("0.25"), { strictEligible: true }); }
    ledger.markSent("sent", "provider-request"); db.close(); dbs.splice(dbs.indexOf(db), 1);
    const reopened = setup(path); reopened.budget.recoverInterrupted();
    expect(reopened.budget.summary("task")).toMatchObject({ activeReservationsAtomic: "0", unresolvedExposureAtomic: decimalToAtomic("0.25"), availableAtomic: decimalToAtomic("0.75"), unknownCount: 1 });
    expect(reopened.ledger.get("sent")).toMatchObject({ status: "outcome_unknown", requestId: "provider-request" });
    expect(reopened.ledger.get("unsent")?.state).toBe("not_sent");
    reopened.budget.recoverInterrupted(); expect(reopened.budget.summary("task").unresolvedExposureAtomic).toBe(decimalToAtomic("0.25"));
  });
  it("makes versioned topups idempotent and records real overspend instead of clipping it", () => {
    const { ledger, pricing, budget } = setup(); const p = pricing.save({ ...input, rates: { input: "1000000", output: "1" } });
    budget.create({ rootTaskId: "task", roomId: "room", mode: "soft_limit", limitAtomic: decimalToAtomic("1") });
    const req = { requestId: "topup", expectedRevision: 1, amountAtomic: decimalToAtomic("0.5") };
    budget.increase("task", req); budget.increase("task", req);
    expect(budget.get("task")).toMatchObject({ limitAtomic: decimalToAtomic("1.5"), revision: 2 });
    expect(() => budget.increase("task", { ...req, requestId: "stale" })).toThrow("budget_revision_conflict");
    ledger.begin(identity("breach"), p.id); budget.reserve("breach", "task", decimalToAtomic("0.01"), { strictEligible: true }); ledger.markSent("breach"); ledger.finish("breach", { usage: { inputTokens: 2, outputTokens: 0 } });
    expect(budget.summary("task")).toMatchObject({ settledKnownAtomic: decimalToAtomic("2"), breached: true, availableAtomic: "-500000000000" });
    ledger.begin(identity("later"), p.id); expect(() => budget.reserve("later", "task", "1", { strictEligible: true })).toThrow("budget_breached");
  });
  it("refuses strict calls lacking a proven upper bound or USD prices", () => {
    const { ledger, pricing, budget } = setup(); budget.create({ rootTaskId: "task", roomId: "room", mode: "strict_admission", limitAtomic: decimalToAtomic("1") });
    ledger.begin(identity("unknown"), null); expect(() => budget.reserve("unknown", "task", "1", { strictEligible: false })).toThrow("budget_unbounded_request");
    ledger.begin(identity("eur"), pricing.save({ ...input, currency: "EUR" }).id); expect(() => budget.reserve("eur", "task", "1", { strictEligible: true })).toThrow("budget_currency_unsupported");
  });
  it("pauses admission when an actual request exceeds its reserve even below the task cap", () => {
    const { ledger, pricing, budget } = setup(), p = pricing.save({ ...input, rates: { input: "200000", output: "1" } });
    budget.create({ rootTaskId: "task", roomId: "room", mode: "soft_limit", limitAtomic: decimalToAtomic("1") });
    ledger.begin(identity("under-reserved"), p.id); budget.reserve("under-reserved", "task", decimalToAtomic("0.1"), { strictEligible: true }); ledger.markSent("under-reserved"); ledger.finish("under-reserved", { usage: { inputTokens: 1, outputTokens: 0 } });
    expect(budget.summary("task")).toMatchObject({ settledKnownAtomic: decimalToAtomic("0.2"), breached: true, blockedReason: "cost_budget_breached" });
    ledger.begin(identity("blocked-after-breach"), p.id); expect(() => budget.reserve("blocked-after-breach", "task", "1", { strictEligible: true })).toThrow("cost_budget_breached");
    budget.increase("task", { requestId: "acknowledge", expectedRevision: 1, amountAtomic: decimalToAtomic("0.1") });
    expect(budget.summary("task").breached).toBe(false);
  });
  it("serializes reservations from independent Bun processes against the same SQLite account", async () => {
    const root = mkdtempSync(join(tmpdir(), "socrates-cost-concurrent-")); roots.push(root); const path = join(root, "race.db");
    const { ledger, pricing, budget } = setup(path), p = pricing.save(input);
    budget.create({ rootTaskId: "task", roomId: "room", mode: "soft_limit", limitAtomic: decimalToAtomic("1") });
    for (const id of ["racer1", "racer2"]) ledger.begin(identity(id), p.id);
    const worker = new URL("./fixtures/cost-reserve-worker.ts", import.meta.url).pathname;
    const processes = ["racer1", "racer2"].map(id => Bun.spawn([process.execPath, worker, path, id], { stdout: "pipe", stderr: "pipe" }));
    const results = await Promise.all(processes.map(async child => { const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); expect(error).toBe(""); expect(exit).toBe(0); return JSON.parse(output) as { accepted: boolean; error?: string }; }));
    expect(results.filter(result => result.accepted)).toHaveLength(1);
    expect(results.find(result => !result.accepted)?.error).toBe("cost_budget_insufficient");
    expect(budget.summary("task").activeReservationsAtomic).toBe(decimalToAtomic("0.60"));
  });
});

it("migration adds cost authority without changing prior token or room facts", () => {
  const db = new Database(":memory:"); dbs.push(db); runMigrations(db, migrations.filter(m => m.version < 23));
  db.exec(`INSERT INTO usage_records(id,stable_key,room_id,input_tokens,source,estimated,created_at) VALUES ('u','old','legacy',123,'provider',0,'then')`);
  runMigrations(db, migrations); expect(db.query("SELECT input_tokens,cost FROM usage_records WHERE id='u'").get()).toEqual({ input_tokens: 123, cost: null });
  expect(new CostLedger(db).summary({ roomId: "legacy" }).historicalUnknownCount).toBe(1);
  db.exec(`INSERT INTO usage_records(id,stable_key,room_id,input_tokens,source,estimated,created_at) VALUES ('new','new','legacy',123,'provider',0,'then')`);
  expect(new CostLedger(db).summary({ roomId: "legacy" }).historicalUnknownCount).toBe(1);
  expect(runMigrations(db, migrations)).toEqual([]);
});
