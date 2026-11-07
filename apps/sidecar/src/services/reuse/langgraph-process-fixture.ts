/** Executed only by compatibility tests, against a temporary database supplied by the test. */
import { openDb } from "../../db";
import { SessionStore } from "../../store/session-store";
import { RoomCommandService } from "../room-command-service";
import { BunSqliteCheckpointSaver } from "./langgraph-checkpoint";
import { buildReuseWorkflow, resumeReuseWorkflow } from "./langgraph-workflow";

const [dbPath, phase] = process.argv.slice(2);
if (!dbPath || !["start", "resume"].includes(phase ?? "")) throw new Error("fixture_arguments_required");
const db = openDb(dbPath);
const sessions = new SessionStore(db);
const room = db.query<{ id: string }, []>("SELECT id FROM sessions LIMIT 1").get()
  ?? sessions.create({ title: "Graph fixture", mode: "chat", primaryAgentId: "a", agents: [{ agentId: "a", snapshot: {}, executionEligible: true }] });
db.exec("CREATE TABLE IF NOT EXISTS fixture_calls(id INTEGER PRIMARY KEY, purpose TEXT NOT NULL)");
const commands = new RoomCommandService(db, sessions, {
  startDirect: async () => { throw new Error("fixture_direct_forbidden"); }, getDirect: () => null,
  createTeam: async () => { throw new Error("fixture_team_forbidden"); },
  resolveAgent: id => ({ id, nickname: id, modelId: "fixture", providerType: "openai_compatible", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture", role: "", systemPrompt: "" }),
  gateway: async function* () {
    db.query("INSERT INTO fixture_calls(purpose) VALUES ('service-dispatch')").run();
    yield { type: "delta", text: "completed once" };
    yield { type: "done", usage: { inputTokens: 2, outputTokens: 2 } };
  },
});
const graph = buildReuseWorkflow(new BunSqliteCheckpointSaver(db), async request => {
  const command = await commands.submit({ roomId: room.id, clientRequestId: "graph-fixture-stable-request", content: request, intent: "discuss", mentions: [] });
  await commands.wait(command.commandId);
  if (commands.get(command.commandId)?.status !== "completed") throw new Error("fixture_task_not_completed");
  return command.commandId;
});
const config = { configurable: { thread_id: `reuse:${room.id}:cost-aware-compatibility-v1` } };
if (phase === "start") {
  await graph.invoke({ request: "controlled task" }, config);
} else {
  const current = await graph.getState(config);
  if (current.next.length) await graph.invoke(resumeReuseWorkflow(), config);
}
const state = await graph.getState(config);
const calls = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM fixture_calls").get()!.count;
console.log(JSON.stringify({ interrupted: state.next.includes("human_review"), approved: state.values.approved ?? false, version: state.values.version,
  invocations: calls, commandStatus: commands.get(state.values.commandId)?.status }));
db.close();
