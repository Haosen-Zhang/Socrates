import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setupCostFlowFixture, untilCostFlow } from "./cost-flow-fixture";

test("direct Native writes consume a durable session grant for a different file without another user decision", async () => {
  const f = await setupCostFlowFixture({ writeApprovalFlow: true, invalidWriteHash: true });
  try {
    const room = f.sessions.get(f.roomIds.work)!;
    f.sessions.updateCollaboration(room.id, { ...room.collaboration, strategy: "single" });
    const command = await f.commands.submit({ roomId: room.id, content: "Create the two controlled files", intent: "execute", mentions: [], clientRequestId: "direct-session-grant" });
    await untilCostFlow(() => f.approvals.recoverPending().pending.length === 1, "first_write_approval");
    const first = f.approvals.recoverPending().pending[0]!;
    expect(first).toMatchObject({ kind: "write_file", sessionId: room.id, toolGeneration: 1, freshHumanRequired: false });
    await f.runner.decide(first.id, { clientDecisionKey: "allow-writes-in-room", decision: "allow_session" });
    await untilCostFlow(() => f.commands.get(command.commandId)?.status === "completed", "direct_writes_complete");
    expect(readFileSync(join(f.workspace.canonicalPath, "result.txt"), "utf8")).toContain("file 0");
    expect(readFileSync(join(f.workspace.canonicalPath, "second.txt"), "utf8")).toContain("file 1");
    expect(f.approvals.recoverPending().pending).toHaveLength(0);
    expect(f.db.query("SELECT COUNT(*) AS n FROM approval_decisions WHERE decision='allow_session'").get()).toEqual({ n: 1 });
    expect(f.db.query("SELECT COUNT(*) AS n FROM approval_decisions WHERE decision='allow_once' AND reason='session_grant'").get()).toEqual({ n: 2 });
    expect(f.db.query("SELECT COUNT(*) AS n FROM tool_calls WHERE name='write_file' AND status='succeeded'").get()).toEqual({ n: 2 });
    expect(f.db.query("SELECT COUNT(*) AS n FROM tool_calls WHERE name='write_file' AND status='failed' AND json_extract(error_detail_json,'$.code')='WORKSPACE_FILE_CHANGED'").get()).toEqual({ n: 1 });
  } finally { await f.close(); }
});

test("a team session grant covers in-plan writes but cannot approve a plan scope expansion", async () => {
  const f = await setupCostFlowFixture({ writeApprovalFlow: true, scopeExpansion: true });
  try {
    const command = await f.commands.submit({ roomId: f.roomIds.work, content: "Create the approved controlled files", intent: "execute", mentions: [], clientRequestId: "team-session-grant" });
    await untilCostFlow(() => f.tasks.get(command.taskId!)?.state === "awaiting_plan_approval", "write_plan_ready");
    const plan = f.tasks.getPlan(command.taskId!)!;
    const response = await f.app.request(`/multi/tasks/${command.taskId}/plan-decisions`, { method: "POST", headers: f.headers,
      body: JSON.stringify({ version: plan.version, hash: plan.contentHash, clientDecisionKey: "write-plan", decision: "approve_exact_plan" }) });
    expect(response.status).toBe(200);
    await untilCostFlow(() => f.approvals.recoverPending().pending.length === 1, "team_first_write");
    const first = f.approvals.recoverPending().pending[0]!;
    expect(first).toMatchObject({ kind: "write_file", sessionId: f.roomIds.work, freshHumanRequired: false });
    await f.execution.decide(first.id, { clientDecisionKey: "allow-team-writer", decision: "allow_session" });
    await untilCostFlow(() => f.approvals.recoverPending().pending.some(request => request.kind === "plan_scope_expansion"), "scope_still_requires_user");
    expect(existsSync(join(f.workspace.canonicalPath, "second.txt"))).toBe(true);
    expect(existsSync(join(f.workspace.canonicalPath, "outside-plan.txt"))).toBe(false);
    const outside = f.approvals.recoverPending().pending[0]!;
    expect(outside.freshHumanRequired).toBe(true);
    expect(f.approvals.hasSessionGrant(outside)).toBe(false);
    await expect(f.execution.decide(outside.id, { clientDecisionKey: "forbidden-broad-scope", decision: "allow_session" })).rejects.toThrow("approval_scope_not_allowed");
    await f.execution.decide(outside.id, { clientDecisionKey: "allow-exact-expansion", decision: "allow_once" });
    await untilCostFlow(() => f.tasks.get(command.taskId!)?.state === "completed", "team_writes_complete");
    expect(existsSync(join(f.workspace.canonicalPath, "outside-plan.txt"))).toBe(true);
    expect(f.db.query("SELECT COUNT(*) AS n FROM approval_decisions WHERE reason='session_grant'").get()).toEqual({ n: 1 });
  } finally { await f.close(); }
});
