import { expect, test } from "bun:test";
import { setupCostFlowFixture, untilCostFlow } from "../services/cost-flow-fixture";

test("cost HTTP routes validate exact price ownership, keep exports text-free and reconcile original facts separately", async () => {
  const f = await setupCostFlowFixture();
  try {
    const post = (path: string, body: unknown) => f.app.request(path, { method: "POST", headers: f.headers, body: JSON.stringify(body) });
    const invalid = await post("/cost/prices", { providerConnectionId: "fixture-provider", modelId: "fixture-model-a", protocol: "openai_chat_completions",
      baseUrl: "https://another.invalid/v1", currency: "USD", rates: { input: "1", output: "1" }, source: "user_confirmed", sourceVersion: "invalid-mapping" });
    expect(invalid.status).toBe(409);
    expect(await invalid.json()).toMatchObject({ error: "price_provider_mapping_invalid" });
    const input = { roomId: f.roomIds.chat, content: "PRIVATE SENTINEL THAT EXPORT MUST EXCLUDE", intent: "respond", mentions: [], maxOutputTokens: 256,
      budget: { mode: "soft_limit", limitAtomic: "1000000000000" } };
    const quoted = await post("/cost/quotes", input);
    expect(quoted.status).toBe(201);
    const quote = await quoted.json() as { id: string };
    const response = await post("/room-commands", { ...input, quoteId: quote.id, clientRequestId: "http-cost" });
    expect(response.status).toBe(202);
    const command = await response.json() as { commandId: string };
    await untilCostFlow(() => f.commands.get(command.commandId)?.status === "completed", "http_direct_completed");
    const room = await (await f.app.request(`/cost/rooms/${f.roomIds.chat}`, { headers: f.headers })).json() as { summary: { invocations: number }; invocations: Array<{ invocationId: string }> };
    expect(room.summary.invocations).toBe(1);
    const exported = await f.app.request(`/cost/rooms/${f.roomIds.chat}/export?format=json`, { headers: f.headers });
    const text = await exported.text();
    expect(text).not.toContain("PRIVATE SENTINEL"); expect(text).not.toContain("fixture-not-a-real-key"); expect(text).toContain("pricingVersions");
    const invocationId = room.invocations[0]!.invocationId;
    const reconcileInput = { requestId: "invoice-confirmed", totalAtomic: "200000000", currency: "USD", reason: "=1+1" };
    expect((await post(`/cost/invocations/${invocationId}/reconcile`, reconcileInput)).status).toBe(200);
    expect((await post(`/cost/invocations/${invocationId}/reconcile`, reconcileInput)).status).toBe(200);
    const fact = f.broker.ledger.get(invocationId)!;
    expect(fact.amount?.atomic).toBe("150000000"); expect(fact.reconciliation?.amount.atomic).toBe("200000000");
    const csv = await (await f.app.request(`/cost/rooms/${f.roomIds.chat}/export?format=csv`, { headers: f.headers })).text();
    expect(csv).toContain("effective_amount_atomic"); expect(csv).toContain('"150000000","200000000","200000000"');
    expect(csv).toContain('"\'=1+1"'); expect(csv).not.toContain("PRIVATE SENTINEL");
    const increase = { requestId: "http-increase", expectedRevision: 1, amountAtomic: "1000000000" };
    expect((await post(`/cost/tasks/${command.commandId}/increase`, increase)).status).toBe(200);
    expect((await post(`/cost/tasks/${command.commandId}/increase`, increase)).status).toBe(200);
    expect(f.broker.budgets.get(command.commandId)?.revision).toBe(2);
    expect(f.broker.budgets.get(command.commandId)?.limitAtomic).toBe("1001000000000");
  } finally { await f.close(); }
});
