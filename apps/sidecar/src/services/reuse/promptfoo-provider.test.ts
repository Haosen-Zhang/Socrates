import { expect, test } from "bun:test";
import { openDb } from "../../db";
import { SessionStore } from "../../store/session-store";
import { RoomCommandService } from "../room-command-service";
import { SocratesTaskProvider } from "./promptfoo-provider";

test("custom evaluation provider completes a real room task, with public history, lifecycle and usage", async () => {
  const db = openDb(":memory:");
  const sessions = new SessionStore(db);
  const room = sessions.create({ title: "Evaluation fixture", mode: "chat", primaryAgentId: "a", agents: [{ agentId: "a", snapshot: { providerId: "fixture", modelId: "fixture-model" }, executionEligible: true }] });
  const commands = new RoomCommandService(db, sessions, {
    startDirect: async () => { throw new Error("must_use_task_service"); }, getDirect: () => null,
    createTeam: async () => { throw new Error("chat_must_not_create_team"); },
    resolveAgent: id => ({ id, nickname: id, modelId: "fixture-model", providerType: "openai_compatible", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-key", role: "", systemPrompt: "" }),
    gateway: async function* () { yield { type: "delta", text: "task-result" }; yield { type: "done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }; },
  });
  const provider = new SocratesTaskProvider({ roomId: room.id, commands, sessions, db });
  const result = await provider.callApi("complete the task");
  expect(result).toMatchObject({ output: "task-result", tokenUsage: { prompt: 10, completion: 5, total: 15 }, metadata: { status: "completed", scope: "socrates_room_task" } });
  expect(sessions.listMessages(room.id).map(message => message.role)).toEqual(["user", "assistant"]);
  expect(commands.list(room.id)).toHaveLength(1);
  db.close();
});
