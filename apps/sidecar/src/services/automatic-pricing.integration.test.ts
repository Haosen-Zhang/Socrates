import { expect, test } from "bun:test";
import { setupCostFlowFixture } from "./cost-flow-fixture";

test("automatic price HTTP views, historical reference exports and one model override form a usable pricing flow", async () => {
  const f = await setupCostFlowFixture({ automaticPricingView: true });
  try {
    const initial = await (await f.app.request(`/cost/rooms/${f.roomIds.work}`, { headers: f.headers })).json();
    expect(initial.summary).toMatchObject({ invocations: 4, estimatedCount: 4, outcomeUnknownCount: 0, unpricedCount: 0, totals: [] });
    expect(BigInt(initial.summary.estimatedTotals[0].atomic)).toBeGreaterThan(0n);
    const historicalBefore = f.db.query("SELECT * FROM cost_invocations WHERE id='pricing-example-0'").get();
    const frozen = f.broker.ledger.get("pricing-example-2")!;
    const prices = await (await f.app.request("/cost/prices?providerId=pricing-openai", { headers: f.headers })).json();
    expect(prices.some((price: { modelId: string; source: string }) => price.modelId === "gpt-5.6-luna" && price.source === "official")).toBe(true);
    const csv = await (await f.app.request(`/cost/rooms/${f.roomIds.work}/export?format=csv`, { headers: f.headers })).text();
    expect(csv).toContain("reference_estimate_atomic"); expect(csv).toContain("728150000");
    const override = await f.app.request("/cost/prices", { method: "POST", headers: f.headers, body: JSON.stringify({ providerConnectionId: "pricing-openai", modelId: "gpt-5.6-luna",
      baseUrl: "https://api.openai.com/v1", protocol: "openai_responses", source: "user_confirmed", sourceVersion: "one-override", currency: "USD",
      rates: { input: "0.4", output: "2", cacheRead: "0.02", cacheWrite: "0.25" } }) });
    expect(override.status).toBe(201);
    expect((await f.app.request("/fixture/pricing-sample", { method: "POST", headers: f.headers })).status).toBe(200);
    const final = await (await f.app.request(`/cost/rooms/${f.roomIds.work}`, { headers: f.headers })).json();
    expect(final.summary).toMatchObject({ invocations: 5, estimatedCount: 4, outcomeUnknownCount: 0, totals: [{ atomic: "72500000" }] });
    expect(f.broker.ledger.get("pricing-example-0")?.referenceEstimate?.amount.atomic).toBe("759950000");
    expect(f.db.query("SELECT * FROM cost_invocations WHERE id='pricing-example-0'").get()).toEqual(historicalBefore);
    expect(f.broker.ledger.get("pricing-example-2")?.priceSnapshotId).toBe(frozen.priceSnapshotId);
    expect(f.broker.ledger.get("pricing-example-2")?.amount).toEqual(frozen.amount);
  } finally { await f.close(); }
});
