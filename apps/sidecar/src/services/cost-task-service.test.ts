import { expect, test } from "bun:test";
import { setupCostFlowFixture, untilCostFlow } from "./cost-flow-fixture";
import { CostTaskService } from "./cost-task-service";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("adaptive budget resume keeps its frozen decision, member, quote and existing child after settings and prices change", async () => {
  const f = await setupCostFlowFixture({ routingFixture: true });
  try {
    const room = f.sessions.get(f.roomIds.work)!;
    // The first tool result grows beyond the cold-start estimate, so the real
    // Broker pauses the next sample after preserving the completed write.
    writeFileSync(join(f.workspace.canonicalPath, "context.txt"), "Synthetic tool result. ".repeat(1600));
    f.sessions.updateCollaboration(room.id, { ...room.collaboration, strategy: "adaptive", assignment: { ...room.collaboration.assignment,
      routing: { ...room.collaboration.assignment.routing, automaticPolicy: "cost", limits: { maxRetries: 0, maxEscalations: 0, maxTotalModelCalls: 24 } } } });
    const base = { roomId: room.id, content: "Complete the controlled fixture task", intent: "execute" as const, mentions: [], maxOutputTokens: 256 };
    const initial = f.quotes.quote(base);
    const input = { ...base, budget: { mode: "soft_limit" as const, limitAtomic: initial.highAtomic! } };
    const quote = f.quotes.quote(input);
    const command = await f.commands.submit({ ...input, quoteId: quote.id, clientRequestId: "routing-resume" });
    await untilCostFlow(() => f.adaptive.get(command.commandId)?.status === "paused_budget", "adaptive_budget_pause");
    const paused = f.adaptive.get(command.commandId)!, frozen = f.routes.get(command.commandId)!;
    expect(paused.attempts).toHaveLength(1); expect(paused.attempts[0]!.child).not.toBeNull();
    const firstChild = paused.attempts[0]!.child!.id;
    expect(f.db.query("SELECT count(*) AS count FROM tool_calls WHERE name='write_file'").get()).toEqual({ count: 1 });
    expect(readFileSync(join(f.workspace.canonicalPath, "result.txt"), "utf8")).toBe("Written once by controlled Native tool.\n");
    // Current preferences and tariff updates apply only to a future root task.
    f.sessions.updateCollaboration(room.id, { ...room.collaboration, strategy: "single", assignment: { ...room.collaboration.assignment,
      routing: { ...room.collaboration.assignment.routing, mode: "manual", lightweightAgentId: "fixture-c" } } });
    const selected = frozen.selected!.assignments.executorIds[0]!, price = frozen.members[selected]!.price!;
    f.broker.prices.save({ ...price, rates: { input: "99", output: "99" }, sourceVersion: "new-rate-after-pause" });
    const quoteCount = f.db.query<{ count: number }, []>("SELECT count(*) AS count FROM cost_quotes").get()!.count;
    const service = new CostTaskService(f.db, f.commands, f.supervisor, f.runner, f.tasks, f.coordinator, f.team, f.execution, { routing: f.routes, adaptive: f.adaptive });
    await expect(service.resume(command.commandId, { requestId: "insufficient" })).rejects.toThrow("cost_budget_insufficient");
    f.broker.budgets.increase(command.commandId, { requestId: "routing-topup", expectedRevision: 1, amountAtomic: "1000000000000" });
    const current = f.sessions.get(room.id)!.collaboration, callsBefore = f.nativeCalls.length;
    f.sessions.updateCollaboration(room.id, { ...current, assignment: { ...current.assignment, routing: { ...current.assignment.routing, allowedProviderIds: [] } } });
    await expect(service.resume(command.commandId, { requestId: "revoked-provider" })).rejects.toThrow("routing_egress_revoked");
    expect(f.nativeCalls).toHaveLength(callsBefore);
    expect(f.adaptive.get(command.commandId)?.attempts).toHaveLength(1);
    f.sessions.updateCollaboration(room.id, current);
    const first = service.resume(command.commandId, { requestId: "resume-frozen", maxOutputTokens: 128 });
    expect(await first).toEqual(await service.resume(command.commandId, { requestId: "resume-frozen", maxOutputTokens: 128 }));
    await untilCostFlow(() => f.adaptive.get(command.commandId)?.status === "completed", "adaptive_resumed");
    const done = f.adaptive.get(command.commandId)!;
    expect(done.attempts).toHaveLength(1); expect(done.attempts[0]!.id).toBe(paused.attempts[0]!.id);
    expect(done.attempts[0]!.child!.id).not.toBe(firstChild);
    expect(f.routes.get(command.commandId)).toEqual(frozen);
    expect(f.nativeCalls.every(call => call.model === frozen.members[selected]!.profile.modelId)).toBe(true);
    expect(f.broker.ledger.list({ rootTaskId: command.commandId }).every(call => call.priceSnapshotId === price.id)).toBe(true);
    expect(f.db.query("SELECT count(*) AS count FROM cost_quotes").get()).toEqual({ count: quoteCount });
    expect(service.configuration(command.commandId)).toEqual({ maxOutputTokens: 128, quoteId: quote.id });
    expect(f.sessions.listMessages(room.id).filter(message => message.role === "user")).toHaveLength(1);
    expect(f.db.query("SELECT count(*) AS count FROM tool_calls WHERE name='write_file'").get()).toEqual({ count: 1 });
  } finally { await f.close(); }
}, 20_000);

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
