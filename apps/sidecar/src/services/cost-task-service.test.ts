import { expect, test } from "bun:test";
import { setupCostFlowFixture, untilCostFlow } from "./cost-flow-fixture";

test("concurrent resume retries reuse one owner and reject a changed output cap under the same request ID", async () => {
  const f = await setupCostFlowFixture();
  try {
    const input = { roomId: f.roomIds.chat, content: "Resume this same request", mentions: [], intent: "respond" as const,
      maxOutputTokens: 256, budget: { mode: "soft_limit" as const, limitAtomic: "1" } };
    const quote = f.quotes.quote(input);
    const command = await f.commands.submit({ ...input, quoteId: quote.id, clientRequestId: "resume-idempotency" });
    await untilCostFlow(() => f.commands.get(command.commandId)?.status === "interrupted", "budget_pause");
    f.broker.budgets.increase(command.commandId, { requestId: "topup", expectedRevision: 1, amountAtomic: "1000000000000" });
    const first = f.costTasks.resume(command.commandId, { requestId: "same-request", maxOutputTokens: 128 });
    const identical = f.costTasks.resume(command.commandId, { requestId: "same-request", maxOutputTokens: 128 });
    const changed = f.costTasks.resume(command.commandId, { requestId: "same-request", maxOutputTokens: 64 });
    await expect(changed).rejects.toThrow("cost_resume_request_conflict");
    expect(await first).toEqual(await identical);
    await untilCostFlow(() => f.commands.get(command.commandId)?.status === "completed", "continued_once");
    expect(f.nativeCalls).toHaveLength(1);
    expect(f.sessions.listMessages(f.roomIds.chat).filter(message => message.role === "user")).toHaveLength(1);
    expect(f.costTasks.configuration(command.commandId)?.maxOutputTokens).toBe(128);
  } finally { await f.close(); }
});
