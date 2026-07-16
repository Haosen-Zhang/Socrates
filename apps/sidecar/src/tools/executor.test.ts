import { describe, expect, it } from "bun:test";
import type { PermissionEvaluation, ToolContext, ToolDefinition } from "@socrates/core";
import { openDb } from "../db";
import { ApprovalManager } from "../approvals/manager";
import { ToolRegistry } from "./registry";
import { ToolExecutor } from "./executor";

function setup(effect: "allow" | "ask" | "deny" = "allow") {
  let executions = 0;
  const tool: ToolDefinition = {
    name: "read_file", description: "read", generation: 1, capability: "workspace_read",
    risk: "low", idempotency: "read",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    async execute() { executions += 1; return "x".repeat(50); },
  };
  const db = openDb(":memory:");
  const approvals = new ApprovalManager(db);
  const executor = new ToolExecutor(db, new ToolRegistry([tool]), approvals, { maxBytes: 10, maxLines: 10 });
  const context: ToolContext = {
    callId: "call", sessionId: "session", taskId: "task", turnId: "turn", agentId: "agent",
    workspaceId: "workspace", mode: "single_agent", phase: "executing", signal: new AbortController().signal,
  };
  return { executor, approvals, context, effect, getExecutions: () => executions };
}

describe("ToolExecutor", () => {
  it("executes a valid allowed read once and persists bounded output", async () => {
    const { executor, context, getExecutions } = setup();
    const request = { stableKey: "stable", name: "read_file", generation: 1, input: { path: "a" }, workspaceIdentity: "w", policyVersion: 1 };
    const first = await executor.invoke(request, context, { effect: "allow", risk: "low", matchedRuleIds: [], reasonCode: "test", freshHumanRequired: false, policyVersion: 1 });
    const second = await executor.invoke(request, context, { effect: "allow", risk: "low", matchedRuleIds: [], reasonCode: "test", freshHumanRequired: false, policyVersion: 1 });
    expect(first.status).toBe("succeeded");
    expect(first.output).toMatchObject({ truncated: true, preview: "xxxxxxxxxx" });
    expect(second.id).toBe(first.id);
    expect(getExecutions()).toBe(1);
  });

  it("fails closed for schema mismatch and stable-key input drift", async () => {
    const { executor, context } = setup();
    const permission: PermissionEvaluation = { effect: "allow", risk: "low", matchedRuleIds: [], reasonCode: "test", freshHumanRequired: false, policyVersion: 1 };
    await expect(executor.invoke({ stableKey: "bad", name: "read_file", generation: 1, input: {}, workspaceIdentity: "w", policyVersion: 1 }, context, permission)).rejects.toThrow("invalid_tool_input");
    await executor.invoke({ stableKey: "drift", name: "read_file", generation: 1, input: { path: "a" }, workspaceIdentity: "w", policyVersion: 1 }, context, permission);
    await expect(executor.invoke({ stableKey: "drift", name: "read_file", generation: 1, input: { path: "b" }, workspaceIdentity: "w", policyVersion: 1 }, context, permission)).rejects.toThrow("tool_call_key_input_mismatch");
  });

  it("persists ask and deny without executing", async () => {
    const { executor, context, getExecutions } = setup();
    const ask = await executor.invoke({ stableKey: "ask", name: "read_file", generation: 1, input: { path: "a" }, workspaceIdentity: "w", policyVersion: 1 }, context,
      { effect: "ask", risk: "low", matchedRuleIds: [], reasonCode: "default", freshHumanRequired: false, policyVersion: 1 });
    expect(ask.status).toBe("awaiting_approval");
    const deny = await executor.invoke({ stableKey: "deny", name: "read_file", generation: 1, input: { path: "a" }, workspaceIdentity: "w", policyVersion: 1 }, { ...context, callId: "call-deny" },
      { effect: "deny", risk: "low", matchedRuleIds: [], reasonCode: "mode", freshHumanRequired: false, policyVersion: 1 });
    expect(deny.status).toBe("failed");
    expect(getExecutions()).toBe(0);
  });

  it("resumes only after an exact durable approval", async () => {
    const { executor, approvals, context, getExecutions } = setup();
    const pending = await executor.invoke({ stableKey: "resume", name: "read_file", generation: 1, input: { path: "a" }, workspaceIdentity: "w", policyVersion: 1, attemptId: "attempt" }, context,
      { effect: "ask", risk: "low", matchedRuleIds: [], reasonCode: "default", freshHumanRequired: false, policyVersion: 1 });
    await expect(executor.resumeApproved(pending.id, context)).rejects.toThrow("tool_approval_missing");
    approvals.decide(pending.approval!.id, { clientDecisionKey: "approve-resume", decision: "allow_once" });
    expect((await executor.resumeApproved(pending.id, context)).status).toBe("succeeded");
    expect(getExecutions()).toBe(1);
  });
});
