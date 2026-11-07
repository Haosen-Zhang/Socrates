import type { Database } from "bun:sqlite";
import type { RoomCommandService } from "../room-command-service";
import type { SessionStore } from "../../store/session-store";
import { UsageCollector } from "../usage-collector";

/** promptfoo's documented custom provider interface; the evaluation target is a whole Socrates task. */
export class SocratesTaskProvider {
  constructor(private readonly input: { roomId: string; commands: RoomCommandService; sessions: SessionStore; db: Database }) {}
  id(): string { return `socrates:room-task:${this.input.roomId}`; }

  async callApi(prompt: string) {
    const command = await this.input.commands.submit({
      roomId: this.input.roomId, clientRequestId: `evaluation:${crypto.randomUUID()}`,
      content: prompt, intent: "discuss", mentions: [],
    });
    await this.input.commands.wait(command.commandId);
    const result = this.input.commands.get(command.commandId);
    if (!result || result.status !== "completed") return { error: result?.error ?? `task_${result?.status ?? "missing"}` };
    const output = this.input.sessions.listMessages(this.input.roomId)
      .filter(message => message.runId === command.commandId && message.role === "assistant")
      .map(message => message.content).join("\n\n");
    const usage = new UsageCollector(this.input.db).summaries(command.commandId);
    const sum = (key: "inputTokens" | "outputTokens" | "totalTokens") => usage.reduce((total, row) => total + (row.cumulative[key] ?? 0), 0);
    const complete = usage.length > 0 && usage.every(row => row.cumulative.inputTokens !== null && row.cumulative.outputTokens !== null);
    return {
      output,
      ...(complete ? { tokenUsage: { prompt: sum("inputTokens"), completion: sum("outputTokens"), total: sum("totalTokens") } } : {}),
      metadata: { commandId: command.commandId, status: result.status, scope: "socrates_room_task", usageComplete: complete },
    };
  }
}
