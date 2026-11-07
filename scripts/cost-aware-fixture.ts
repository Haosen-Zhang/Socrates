import { writeFileSync, unlinkSync } from "node:fs";
import { setupCostFlowFixture } from "../apps/sidecar/src/services/cost-flow-fixture";

const fixture = await setupCostFlowFixture({ reasoningPlanner: process.env.SOCRATES_FIXTURE_REASONING_PLANNER === "1",
  writeApprovalFlow: process.env.SOCRATES_FIXTURE_WRITE_APPROVAL === "1", scopeExpansion: process.env.SOCRATES_FIXTURE_WRITE_APPROVAL === "1",
  automaticPricingView: process.env.SOCRATES_FIXTURE_AUTOMATIC_PRICING === "1" });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: fixture.app.fetch });
const metadata = { port: server.port, processId: process.pid, token: fixture.token, roomIds: fixture.roomIds, workspace: fixture.workspace,
  reasoningPlanner: process.env.SOCRATES_FIXTURE_REASONING_PLANNER === "1",
  writeApprovalFlow: process.env.SOCRATES_FIXTURE_WRITE_APPROVAL === "1",
  automaticPricingView: process.env.SOCRATES_FIXTURE_AUTOMATIC_PRICING === "1",
  providerId: "fixture-provider", providerName: "Controlled fixture Provider", modelIds: ["fixture-model-a", "fixture-model-b"],
  recommendedBudgetUsd: "0.023", source: "synthetic-fixture", temporaryDirectory: fixture.directory };
const metadataPath = "/private/tmp/socrates-cost-fixture.json";
writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
console.log(JSON.stringify({ metadataPath, ...metadata }));
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  server.stop(true);
  void fixture.close().finally(() => { try { unlinkSync(metadataPath); } catch { /* Already removed. */ } process.exit(0); });
});
