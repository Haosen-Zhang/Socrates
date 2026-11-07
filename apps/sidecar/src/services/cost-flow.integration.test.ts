import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setupCostFlowFixture, untilCostFlow } from "./cost-flow-fixture";
import { openDb } from "../db";
import { BudgetLedger, CostLedger } from "./cost-ledger";

test("actual AI SDK planning honors legacy caps and automatically enlarges a truncated new task without asking the user", async () => {
  const f = await setupCostFlowFixture({ reasoningPlanner: true });
  try {
    const low = await f.commands.submit({ roomId: f.roomIds.work, content: "Controlled reasoning planner", intent: "execute", mentions: [], maxOutputTokens: 1024, clientRequestId: "reasoning-low" });
    await untilCostFlow(() => f.tasks.get(low.taskId!)?.state === "failed", "truncated_plan");
    expect(f.tasks.get(low.taskId!)?.terminalReason).toBe("structured_plan_output_truncated");
    const calls = f.broker.ledger.list({ rootTaskId: low.commandId });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ state: "finished", status: "priced", finishReason: "length", usage: { outputTokens: 1024, reasoningTokens: 1024 } });
    expect(f.tasks.getPlan(low.taskId!)).toBeNull();
    expect(f.nativeCalls).toHaveLength(0);
    const input = { roomId: f.roomIds.work, content: "Controlled reasoning planner", intent: "execute" as const, mentions: [] };
    const quote = f.quotes.quote(input);
    expect(quote.maxOutputTokens).toBe(32768);
    const normal = await f.commands.submit({ ...input, quoteId: quote.id, clientRequestId: "reasoning-default" });
    await untilCostFlow(() => f.tasks.get(normal.taskId!)?.state === "awaiting_plan_approval", "complete_plan");
    expect(f.gatewayCalls.map(call => call.maxOutputTokens)).toEqual([1024, 8192, 32768]);
    expect(f.tasks.getPlan(normal.taskId!)?.content.workPackages).toHaveLength(2);
    expect(f.nativeCalls).toHaveLength(0);
    const normalCalls = f.broker.ledger.list({ rootTaskId: normal.commandId });
    expect(normalCalls).toHaveLength(2);
    expect(normalCalls[0]).toMatchObject({ finishReason: "length", usage: { reasoningTokens: 8192 } });
    expect(normalCalls[1]).toMatchObject({ finishReason: "stop", usage: { reasoningTokens: 1024 } });
  } finally { await f.close(); }
});

test("automatic planning expansion pauses at monetary admission and resumes its checkpoint after adding funds", async () => {
  const f = await setupCostFlowFixture({ reasoningPlanner: true });
  try {
    const input = { roomId: f.roomIds.work, content: "Controlled reasoning planner", intent: "execute" as const, mentions: [],
      budget: { mode: "soft_limit" as const, limitAtomic: "20000000000" } };
    const quote = f.quotes.quote(input);
    const command = await f.commands.submit({ ...input, quoteId: quote.id, clientRequestId: "auto-expand-budget" });
    await untilCostFlow(() => f.tasks.get(command.taskId!)?.state === "paused", "expansion_admission_pause");
    expect(f.tasks.get(command.taskId!)).toMatchObject({ resumeFrom: "synthesizing", terminalReason: "cost_budget_insufficient" });
    expect(f.gatewayCalls.map(call => call.maxOutputTokens)).toEqual([8192]);
    expect(f.broker.budgets.summary(command.commandId).settledKnownAtomic).toBe("9212000000");
    f.broker.budgets.increase(command.commandId, { requestId: "auto-funds", expectedRevision: 1, amountAtomic: "1000000000000" });
    await f.costTasks.resume(command.commandId, { requestId: "auto-resume" });
    await untilCostFlow(() => f.tasks.get(command.taskId!)?.state === "awaiting_plan_approval", "expanded_plan_ready");
    expect(f.gatewayCalls.map(call => call.maxOutputTokens)).toEqual([8192, 32768]);
    expect(f.broker.ledger.list({ rootTaskId: command.commandId }).filter(call => call.state === "finished")).toHaveLength(2);
    expect(f.tasks.getPlan(command.taskId!)?.content.workPackages).toHaveLength(2);
    expect(f.nativeCalls).toHaveLength(0);
  } finally { await f.close(); }
});

test("manual team uses production quote/plan/native/tool/ledger services and resumes the same budget root without repeating writes", async () => {
  const f = await setupCostFlowFixture();
  try {
    const input = { roomId: f.roomIds.work, content: "Complete the fixture collaboration", intent: "execute" as const, mentions: [], maxOutputTokens: 256,
      budget: { mode: "soft_limit" as const, limitAtomic: "15000000000" } };
    const quote = f.quotes.quote(input);
    expect(quote.kind).toBe("team");
    expect(quote.priceSnapshotIds).toHaveLength(2);
    const command = await f.commands.submit({ ...input, quoteId: quote.id, clientRequestId: "integration-team" });
    await untilCostFlow(() => f.tasks.get(command.taskId!)?.state === "awaiting_plan_approval", "team_plan_ready");
    const plan = f.tasks.getPlan(command.taskId!)!;
    expect(plan.content.workPackages).toHaveLength(2);
    const approved = await f.app.request(`/multi/tasks/${command.taskId}/plan-decisions`, { method: "POST", headers: f.headers,
      body: JSON.stringify({ version: plan.version, hash: plan.contentHash, clientDecisionKey: "integration-approve", decision: "approve_exact_plan" }) });
    expect(approved.status).toBe(200);
    await untilCostFlow(() => !f.team.isActive(command.taskId!) && f.tasks.get(command.taskId!)?.state === "paused", "team_budget_pause");
    expect(f.commands.get(command.commandId)?.status).toBe("paused");
    expect(f.broker.budgets.latestBlocked(command.commandId)?.reason).toContain("cost_budget");
    expect(readFileSync(join(f.workspace.canonicalPath, "result.txt"), "utf8")).toBe("Written once by controlled Native tool.\n");
    expect(f.db.query("SELECT COUNT(*) AS count FROM workspace_leases").get()).toEqual({ count: 0 });
    expect(f.db.query("SELECT COUNT(*) AS count FROM tool_calls WHERE name='write_file'").get()).toEqual({ count: 1 });
    const topup = f.broker.budgets.increase(command.commandId, { requestId: "integration-topup", expectedRevision: 1, amountAtomic: "1000000000000" });
    expect(topup.limitAtomic).toBe("1015000000000");
    await f.costTasks.resume(command.commandId, { requestId: "integration-resume" });
    await untilCostFlow(() => !f.team.isActive(command.taskId!) && f.tasks.get(command.taskId!)?.state === "completed", "team_resumed_completion");
    expect(f.commands.get(command.commandId)?.taskId).toBe(command.taskId);
    expect(f.db.query("SELECT COUNT(*) AS count FROM tool_calls WHERE name='write_file'").get()).toEqual({ count: 1 });
    expect(f.db.query("SELECT COUNT(*) AS count FROM workspace_leases").get()).toEqual({ count: 0 });
    const summary = f.broker.ledger.summary({ rootTaskId: command.commandId });
    expect(summary.unknownCount).toBe(0);
    expect(summary.totals).toEqual([{ currency: "USD", atomic: "900000000", scale: 12 }]);
    const priced = f.broker.ledger.list({ rootTaskId: command.commandId }).filter(item => item.state === "finished");
    expect(priced.map(item => item.purpose).sort()).toEqual(["execute", "execute", "execute", "plan", "review", "review"]);
    expect(new Set(priced.map(item => item.invocationId)).size).toBe(6);
    expect(f.team.list(command.taskId!).every(item => item.state === "completed")).toBe(true);
    expect(f.nativeCalls.every(call => call.maxOutputTokens === 256)).toBe(true);
  } finally { await f.close(); }
}, 20_000);

test("discussion and configured summary share a budget, pause before a request and resume without a new user message", async () => {
  const f = await setupCostFlowFixture();
  try {
    const input = { roomId: f.roomIds.chat, content: "Discuss with summary", intent: "discuss" as const, mentions: [], maxOutputTokens: 256,
      budget: { mode: "soft_limit" as const, limitAtomic: "1000000000" } };
    const quote = f.quotes.quote(input);
    const command = await f.commands.submit({ ...input, quoteId: quote.id, clientRequestId: "integration-discussion" });
    await f.commands.wait(command.commandId);
    expect(f.commands.get(command.commandId)?.status).toBe("paused");
    expect(f.gatewayCalls).toHaveLength(0);
    f.broker.budgets.increase(command.commandId, { requestId: "discussion-topup", expectedRevision: 1, amountAtomic: "1000000000000" });
    await f.costTasks.resume(command.commandId, { requestId: "discussion-resume" });
    await f.commands.wait(command.commandId);
    expect(f.commands.get(command.commandId)?.status).toBe("completed");
    expect(f.sessions.listMessages(f.roomIds.chat).filter(message => message.role === "user")).toHaveLength(1);
    expect(f.broker.ledger.list({ rootTaskId: command.commandId }).filter(item => item.state === "finished").map(item => item.purpose)).toEqual(["respond", "respond", "summarize"]);
  } finally { await f.close(); }
});

test("direct Chat uses the same invocation budget and continuation without tools or duplicate public user input", async () => {
  const f = await setupCostFlowFixture();
  try {
    const input = { roomId: f.roomIds.chat, content: "Respond directly", intent: "respond" as const, mentions: [], maxOutputTokens: 256,
      budget: { mode: "soft_limit" as const, limitAtomic: "100000000" } };
    const quote = f.quotes.quote(input);
    const command = await f.commands.submit({ ...input, quoteId: quote.id, clientRequestId: "integration-direct" });
    await untilCostFlow(() => f.commands.get(command.commandId)?.status === "interrupted", "direct_budget_pause");
    expect(f.nativeCalls).toHaveLength(0);
    f.broker.budgets.increase(command.commandId, { requestId: "direct-topup", expectedRevision: 1, amountAtomic: "1000000000000" });
    await f.costTasks.resume(command.commandId, { requestId: "direct-resume" });
    await untilCostFlow(() => f.commands.get(command.commandId)?.status === "completed", "direct_resume_complete");
    expect(f.nativeCalls).toHaveLength(1);
    expect(f.broker.ledger.summary({ rootTaskId: command.commandId })).toMatchObject({ unknownCount: 0, totals: [{ currency: "USD", atomic: "150000000", scale: 12 }] });
    expect(f.sessions.listMessages(f.roomIds.chat).filter(message => message.role === "user")).toHaveLength(1);
    expect(f.db.query("SELECT COUNT(*) AS count FROM tool_calls").get()).toEqual({ count: 0 });
  } finally { await f.close(); }
});

test("missing Native usage retains exposure across database reopen and blocks topup-only replay of a completed tool", async () => {
  const f = await setupCostFlowFixture({ missingFirstNativeUsage: true });
  try {
    const input = { roomId: f.roomIds.work, content: "Keep unknown model consumption explicit", intent: "execute" as const, mentions: [], maxOutputTokens: 256,
      budget: { mode: "soft_limit" as const, limitAtomic: "15000000000" } };
    const quote = f.quotes.quote(input);
    const command = await f.commands.submit({ ...input, quoteId: quote.id, clientRequestId: "integration-unknown" });
    await untilCostFlow(() => f.tasks.get(command.taskId!)?.state === "awaiting_plan_approval", "unknown_plan_ready");
    const plan = f.tasks.getPlan(command.taskId!)!;
    await f.app.request(`/multi/tasks/${command.taskId}/plan-decisions`, { method: "POST", headers: f.headers,
      body: JSON.stringify({ version: plan.version, hash: plan.contentHash, clientDecisionKey: "unknown-approve", decision: "approve_exact_plan" }) });
    await untilCostFlow(() => !f.team.isActive(command.taskId!) && f.tasks.get(command.taskId!)?.state === "paused", "unknown_pause");
    expect(readFileSync(join(f.workspace.canonicalPath, "result.txt"), "utf8")).toBe("Written once by controlled Native tool.\n");
    expect(f.broker.ledger.summary({ rootTaskId: command.commandId }).unknownCount).toBe(1);
    const reopened = openDb(join(f.directory, "fixture.db"));
    try {
      new BudgetLedger(reopened).recoverInterrupted();
      expect(new CostLedger(reopened).summary({ rootTaskId: command.commandId }).unknownCount).toBe(1);
      expect(BigInt(new BudgetLedger(reopened).summary(command.commandId)!.unresolvedExposureAtomic)).toBeGreaterThan(0n);
    } finally { reopened.close(); }
    f.broker.budgets.increase(command.commandId, { requestId: "unknown-topup", expectedRevision: 1, amountAtomic: "1000000000000" });
    await expect(f.costTasks.resume(command.commandId, { requestId: "unknown-resume" })).rejects.toThrow("cost_budget_reconciliation_required");
    expect(f.db.query("SELECT COUNT(*) AS count FROM tool_calls WHERE name='write_file'").get()).toEqual({ count: 1 });
    expect(f.nativeCalls).toHaveLength(1);
    expect(f.db.query("SELECT COUNT(*) AS count FROM workspace_leases").get()).toEqual({ count: 0 });
  } finally { await f.close(); }
});

test("fixture transport fault produces real unknown exposure and manual invoice reconciliation preserves original facts", async () => {
  const f = await setupCostFlowFixture();
  try {
    const armed = await f.app.request("/fixture/next-call-unknown", { method: "POST", headers: f.headers });
    expect(armed.status).toBe(200);
    const input = { roomId: f.roomIds.chat, content: "Fixture network failure", intent: "discuss" as const, mentions: [], maxOutputTokens: 256,
      budget: { mode: "soft_limit" as const, limitAtomic: "1000000000000" } };
    const quote = f.quotes.quote(input);
    const command = await f.commands.submit({ ...input, quoteId: quote.id, clientRequestId: "integration-transport-fault" });
    await f.commands.wait(command.commandId);
    expect(f.broker.ledger.summary({ rootTaskId: command.commandId }).unknownCount).toBe(1);
    expect(BigInt(f.broker.budgets.summary(command.commandId)!.unresolvedExposureAtomic)).toBeGreaterThan(0n);
    const original = f.broker.ledger.list({ rootTaskId: command.commandId })[0]!;
    const body = { requestId: "invoice-fixture", totalAtomic: "150000000", currency: "USD", reason: "Controlled supplier invoice" };
    const result = await f.app.request(`/cost/invocations/${original.invocationId}/reconcile`, { method: "POST", headers: f.headers, body: JSON.stringify(body) });
    expect(result.status).toBe(200);
    expect(f.broker.ledger.summary({ rootTaskId: command.commandId })).toMatchObject({ unknownCount: 0, totals: [{ currency: "USD", atomic: "150000000", scale: 12 }] });
    expect(f.broker.ledger.get(original.invocationId)).toMatchObject({ state: original.state, usage: original.usage, priceSnapshotId: original.priceSnapshotId });
    expect(f.broker.budgets.summary(command.commandId)?.unresolvedExposureAtomic).toBe("0");
  } finally { await f.close(); }
});

test("an over-budget Reviewer pauses its own stage and resumes review without rerunning the completed Worker", async () => {
  const f = await setupCostFlowFixture();
  try {
    const reviewer = f.sessions.get(f.roomIds.work)!.agents.find(member => member.agentId === "fixture-b")!;
    f.sessions.updateAgentSnapshot(f.roomIds.work, "fixture-b", { ...reviewer.snapshot, systemPrompt: "Controlled review instructions. ".repeat(3_000) });
    const input = { roomId: f.roomIds.work, content: "Review within the task budget", intent: "execute" as const, mentions: [], maxOutputTokens: 256,
      budget: { mode: "soft_limit" as const, limitAtomic: "30000000000" } };
    const quote = f.quotes.quote(input);
    const command = await f.commands.submit({ ...input, quoteId: quote.id, clientRequestId: "review-budget" });
    await untilCostFlow(() => f.tasks.get(command.taskId!)?.state === "awaiting_plan_approval", "review_plan_ready");
    const plan = f.tasks.getPlan(command.taskId!)!;
    const approval = await f.app.request(`/multi/tasks/${command.taskId}/plan-decisions`, { method: "POST", headers: f.headers,
      body: JSON.stringify({ version: plan.version, hash: plan.contentHash, clientDecisionKey: "review-approve", decision: "approve_exact_plan" }) });
    expect(approval.status).toBe(200);
    await untilCostFlow(() => !f.team.isActive(command.taskId!) && f.tasks.get(command.taskId!)?.state === "paused", "review_budget_pause");
    expect(f.broker.budgets.latestBlocked(command.commandId)?.details.purpose).toBe("review");
    expect(f.team.list(command.taskId!)[0]!.state).toBe("awaiting_review");
    expect(f.nativeCalls).toHaveLength(2);
    expect(f.db.query("SELECT COUNT(*) AS count FROM tool_calls WHERE name='write_file'").get()).toEqual({ count: 1 });
    expect(f.db.query("SELECT COUNT(*) AS count FROM workspace_leases").get()).toEqual({ count: 0 });
    f.broker.budgets.increase(command.commandId, { requestId: "review-topup", expectedRevision: 1, amountAtomic: "1000000000000" });
    await f.costTasks.resume(command.commandId, { requestId: "review-resume" });
    await untilCostFlow(() => !f.team.isActive(command.taskId!) && f.tasks.get(command.taskId!)?.state === "completed", "review_completed");
    expect(f.nativeCalls).toHaveLength(3);
    expect(f.db.query("SELECT COUNT(*) AS count FROM tool_calls WHERE name='write_file'").get()).toEqual({ count: 1 });
    expect(f.broker.ledger.summary({ rootTaskId: command.commandId }).totals).toEqual([{ currency: "USD", atomic: "900000000", scale: 12 }]);
  } finally { await f.close(); }
});
