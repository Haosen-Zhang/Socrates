import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../apps/sidecar/src/db";
import { SessionStore } from "../../apps/sidecar/src/store/session-store";
import { RoomCommandService } from "../../apps/sidecar/src/services/room-command-service";
import { SocratesTaskProvider } from "../../apps/sidecar/src/services/reuse/promptfoo-provider";

// This package is an opt-in development experiment, not a desktop runtime dependency.
const dir = mkdtempSync(join(tmpdir(), "socrates-promptfoo-"));
Object.assign(process.env, {
  PROMPTFOO_CONFIG_DIR: dir, PROMPTFOO_DISABLE_TELEMETRY: "true", PROMPTFOO_DISABLE_UPDATE: "true",
  PROMPTFOO_DISABLE_SHARING: "true", PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION: "true", IS_TESTING: "true",
});
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error("network_forbidden_in_reuse_fixture"); }) as typeof fetch;
const db = openDb(join(dir, "socrates.db"));
try {
  const sessions = new SessionStore(db);
  const room = sessions.create({ title: "promptfoo task smoke", mode: "chat", primaryAgentId: "fixture-agent", agents: [{ agentId: "fixture-agent", snapshot: {}, executionEligible: true }] });
  const commands = new RoomCommandService(db, sessions, {
    startDirect: async () => { throw new Error("fixture_direct_forbidden"); }, getDirect: () => null,
    createTeam: async () => { throw new Error("fixture_team_forbidden"); },
    resolveAgent: id => ({ id, nickname: id, modelId: "controlled-fixture", providerType: "openai_compatible", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-only", role: "", systemPrompt: "" }),
    gateway: async function* () { yield { type: "delta", text: "Socrates task completed" }; yield { type: "done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }; },
  });
  const { evaluate } = await import("promptfoo");
  const evaluation = await evaluate({
    prompts: ["Complete this controlled task"], providers: [new SocratesTaskProvider({ roomId: room.id, commands, sessions, db })],
    tests: [{ vars: {}, assert: [{ type: "equals", value: "Socrates task completed" }] }],
    sharing: false, writeLatestResults: false,
  }, { cache: false, maxConcurrency: 1, showProgressBar: false });
  const summary = await evaluation.toEvaluateSummary();
  if (summary.stats.successes !== 1 || summary.stats.failures !== 0) throw new Error(`promptfoo_smoke_failed:${JSON.stringify(summary.stats)}`);
  const result = summary.results[0];
  if (result?.response.tokenUsage?.total !== 15 || sessions.listMessages(room.id).length !== 2) throw new Error("promptfoo_task_usage_missing");
  console.log(JSON.stringify({ library: "promptfoo", version: "0.125.1", successes: summary.stats.successes,
    failures: summary.stats.failures, taskCommands: commands.list(room.id).length, tokenUsage: result.response.tokenUsage,
    network: "forbidden", persistence: "temporary-only", sharing: false }));
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
