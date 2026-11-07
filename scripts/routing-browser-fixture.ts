import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setupCostFlowFixture } from "../apps/sidecar/src/services/cost-flow-fixture";

// Real routing, Native execution, approvals and verification over synthetic data.
// The provider boundary is the same controlled model fixture used by cost tests.
const f = await setupCostFlowFixture({ routingFixture: true });
const room = f.sessions.get(f.roomIds.work)!;
f.sessions.rename(room.id, "Routing Work");
f.sessions.rename(f.roomIds.chat, "Routing Chat");
f.sessions.updateCollaboration(room.id, { ...room.collaboration, strategy: "single", assignment: { ...room.collaboration.assignment, callableAgentIds: ["fixture-a", "fixture-b"] } });
for (const module of ["module-a", "module-b"]) {
  mkdirSync(join(f.workspace.canonicalPath, module), { recursive: true });
  writeFileSync(join(f.workspace.canonicalPath, module, "package.json"), JSON.stringify({ name: `synthetic-${module}` }));
  writeFileSync(join(f.workspace.canonicalPath, module, "readme.md"), `Synthetic ${module} documentation.\n`);
}
f.app.get("/__routing/counts", c => c.json({ gateway: f.gatewayCalls, native: f.nativeCalls, controlledFixture: true }));
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: f.app.fetch });
const metadataPath = "/private/tmp/socrates-routing-browser-fixture.json";
writeFileSync(metadataPath, JSON.stringify({ source: "synthetic-routing-browser", port: server.port, token: f.token, processId: process.pid, roomIds: f.roomIds, workspaceId: f.workspace.id }, null, 2));
console.log(JSON.stringify({ metadataPath, port: server.port, source: "synthetic-routing-browser" }));
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true; server.stop(true);
  void f.close().finally(() => { try { unlinkSync(metadataPath); } catch { /* Already removed. */ } process.exit(0); });
});
