import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../db";
import { SessionStore } from "../store/session-store";
import { TaskQuoteService, type QuoteInput } from "./task-quotes";
import { PricingStore } from "./pricing-store";
const dbs: Database[] = []; afterEach(() => dbs.splice(0).forEach(db => db.close()));
function setup() {
  const db = openDb(":memory:"); dbs.push(db);
  db.query("INSERT INTO providers(id,name,type,base_url,api_key_ref,created_at,updated_at) VALUES ('p','Fixture','openai_compatible','https://fixture.invalid/v1','unused','now','now')").run();
  const sessions = new SessionStore(db);
  const room = sessions.create({ mode: "chat", title: "Quote", primaryAgentId: "a", agents: ["a", "b"].map(agentId => ({ agentId,
    snapshot: { providerId: "p", modelId: "fixture", nickname: agentId, role: "Member" }, executionEligible: true })) });
  const prices = new PricingStore(db);
  const price = prices.save({ providerConnectionId: "p", modelId: "fixture", protocol: "openai_chat_completions", baseUrl: "https://fixture.invalid/v1",
    currency: "USD", rates: { input: "1", output: "2" }, source: "user_confirmed", sourceVersion: "fixture/1" });
  const quotes = new TaskQuoteService(db, sessions);
  const input: QuoteInput = { roomId: room.id, content: "Discuss options", mentions: [{ type: "all" }], intent: "discuss", maxOutputTokens: 100,
    budget: { mode: "soft_limit", limitAtomic: "1000000000000" } };
  return { db, room, sessions, quotes, input, prices, price };
}
test("quotes are local persisted heuristics with separately costed discussion, summary and retry stages", () => {
  const { quotes, input, db, room } = setup();
  const quote = quotes.quote(input);
  expect(quote).toMatchObject({ heuristic: true, kind: "discussion", currency: "USD", maxOutputTokens: 100 });
  expect(BigInt(quote.highAtomic!)).toBeGreaterThan(BigInt(quote.lowAtomic!));
  expect(quote.stages.map(stage => stage.stage)).toContain("discussion");
  expect(quote.stages.map(stage => stage.stage)).toContain("retry_allowance");
  expect(quotes.get(quote.id)?.inputHash).toBe(quote.inputHash);
  expect(db.query("SELECT id FROM cost_invocations WHERE room_id=?").all(room.id)).toHaveLength(0);
  expect(db.query("SELECT id FROM session_messages WHERE session_id=?").all(room.id)).toHaveLength(0);
});
test("draft, selected member, output cap, price and room changes each invalidate the bound quote", () => {
  const { quotes, input, prices, price, sessions, room } = setup();
  const quote = quotes.quote(input), command = { ...input, clientRequestId: "submit", quoteId: quote.id };
  expect(quotes.validate(command)?.id).toBe(quote.id);
  expect(() => quotes.validate({ ...command, content: "A changed request" })).toThrow("quote_stale");
  expect(() => quotes.validate({ ...command, mentions: [{ type: "agent", agentId: "a" }] })).toThrow("quote_stale");
  expect(() => quotes.validate({ ...command, maxOutputTokens: 200 })).toThrow("quote_stale");
  prices.save({ ...price, sourceVersion: "new-price", rates: { input: "9", output: "10" } });
  expect(() => quotes.validate(command)).toThrow("quote_stale");
  const second = quotes.quote(input);
  sessions.updateAgentSnapshot(room.id, "a", { providerId: "p", modelId: "fixture", role: "Changed role" });
  expect(() => quotes.validate({ ...command, quoteId: second.id })).toThrow("quote_stale");
});
test("expired quotes and a budget without a bound quote cannot start, and unlisted-model presets remain visibly estimated", () => {
  const { db, quotes, input, sessions, room } = setup();
  const quote = quotes.quote(input);
  db.query("UPDATE cost_quotes SET quote_json=? WHERE id=?").run(JSON.stringify({ ...quote, expiresAt: "2000-01-01T00:00:00Z" }), quote.id);
  expect(() => quotes.validate({ ...input, clientRequestId: "expired", quoteId: quote.id })).toThrow("quote_stale");
  expect(() => quotes.validate({ ...input, clientRequestId: "missing" })).toThrow("quote_required_for_budget");
  sessions.updateAgentSnapshot(room.id, "a", { providerId: "p", modelId: "unknown-model" });
  const unknown = quotes.quote(input);
  expect(BigInt(unknown.lowAtomic!)).toBeGreaterThan(0n); expect(BigInt(unknown.highAtomic!)).toBeGreaterThan(BigInt(unknown.lowAtomic!));
  expect(unknown.unknowns).toContain("prices_are_reference_estimates");
});
test("quotes reject Chat file access and references owned by another workspace", () => {
  const { quotes, input } = setup();
  expect(() => quotes.quote({ ...input, mentions: [{ type: "file", refId: "private-ref" }] })).toThrow("chat_file_mentions_forbidden");
  expect(() => quotes.quote({ ...input, attachmentIds: ["missing-attachment"] })).toThrow("attachment_not_found");
});
