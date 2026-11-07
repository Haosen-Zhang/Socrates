import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setupCostFlowFixture, untilCostFlow } from "../apps/sidecar/src/services/cost-flow-fixture";

// Temporary workspace and production services. Only external model responses are controlled.
const f = await setupCostFlowFixture();
const room = f.sessions.get(f.roomIds.work)!;
f.sessions.rename(room.id, "Verification Work");
f.sessions.rename(f.roomIds.chat, "Verification Chat");
f.sessions.updateCollaboration(room.id, { ...room.collaboration, strategy: "single" });
writeFileSync(join(f.workspace.canonicalPath, "data.json"), JSON.stringify({ value: 1 }));
writeFileSync(join(f.workspace.canonicalPath, "package.json"), JSON.stringify({ name: "synthetic-verification-fixture", scripts: { test: "bun test acceptance.test.ts" } }));
const testSource = `import {test,expect} from 'bun:test';\nimport {readFileSync} from 'node:fs';\ntest('independent fixture invariant',()=>expect(JSON.parse(readFileSync('data.json','utf8')).value).toBe(1));\n`;
writeFileSync(join(f.workspace.canonicalPath, "acceptance.test.ts"), testSource);
const direct = await f.commands.submit({ roomId: room.id, clientRequestId: "verification-fixture-direct", content: "Create a controlled local result", intent: "execute", mentions: [] });
await untilCostFlow(() => f.commands.get(direct.commandId)?.status === "completed", "verification_fixture_direct");
f.app.get("/__verification/counts", c => c.json({ gateway: f.gatewayCalls.length, native: f.nativeCalls.length }));
f.app.post("/__verification/alter", async c => {
  const { kind } = await c.req.json() as { kind: string };
  if (kind === "artifact") writeFileSync(join(f.workspace.canonicalPath, "result.txt"), "Changed after verification.\n");
  else if (kind === "data-fail") writeFileSync(join(f.workspace.canonicalPath, "data.json"), JSON.stringify({ value: 2 }));
  else if (kind === "data-pass") writeFileSync(join(f.workspace.canonicalPath, "data.json"), JSON.stringify({ value: 1 }));
  else if (kind === "contract") writeFileSync(join(f.workspace.canonicalPath, "acceptance.test.ts"), `${testSource}\n// Synthetic external contract change.\n`);
  else return c.json({ error: "invalid_fixture_alter" }, 400);
  return c.json({ controlledFixture: true });
});
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: f.app.fetch });
const metadataPath = "/private/tmp/socrates-verification-browser-fixture.json";
writeFileSync(metadataPath, JSON.stringify({ source: "synthetic-verification-browser", port: server.port, token: f.token, processId: process.pid, roomIds: f.roomIds, workspaceId: f.workspace.id, commandId: direct.commandId }, null, 2));
console.log(JSON.stringify({ metadataPath, port: server.port, source: "synthetic-verification-browser" }));
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true; server.stop(true);
  void f.close().finally(() => { try { unlinkSync(metadataPath); } catch { /* Already removed. */ } process.exit(0); });
});
