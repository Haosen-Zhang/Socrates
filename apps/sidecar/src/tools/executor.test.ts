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
    validateInput(input) {
      return (input as { path?: string }).path === "forbidden" ? ["path_forbidden"] : [];
    },
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
    await expect(executor.invoke({ stableKey: "semantic-bad", name: "read_file", generation: 1, input: { path: "forbidden" }, workspaceIdentity: "w", policyVersion: 1 }, context, permission))
      .rejects.toThrow("invalid_tool_input:path_forbidden");
    await executor.invoke({ stableKey: "drift", name: "read_file", generation: 1, input: { path: "a" }, workspaceIdentity: "w", policyVersion: 1 }, context, permission);
    await expect(executor.invoke({ stableKey: "drift", name: "read_file", generation: 1, input: { path: "b" }, workspaceIdentity: "w", policyVersion: 1 }, context, permission)).rejects.toThrow("tool_call_key_input_mismatch");
  });

  it("persists ask and deny without executing", async () => {
    const { executor, context, getExecutions } = setup();
    const ask = await executor.invoke({ stableKey: "ask", name: "read_file", generation: 1, input: { path: "a" }, workspaceIdentity: "w", policyVersion: 1 }, context,
      { effect: "ask", risk: "low", matchedRuleIds: [], reasonCode: "default", freshHumanRequired: false, policyVersion: 1 });
    expect(ask.status).toBe("awaiting_approval");
    const deny = await executor.invoke({ stableKey: "deny", name: "read_file", generation: 1, input: { path: "a" }, workspaceIdentity: "w", policyVersion: 1 }, { ...context, callId: "call-deny" },
      { effect: "deny", risk: "low", matchedRuleIds: [], reasonCode: "room_policy", freshHumanRequired: false, policyVersion: 1 });
    expect(deny.status).toBe("failed");
    expect(deny.error).toBe("policy_denied:room_policy");
    const capabilityDeny = await executor.invoke({ stableKey: "capability-deny", name: "read_file", generation: 1, input: { path: "a" }, workspaceIdentity: "w", policyVersion: 1 }, { ...context, callId: "call-capability-deny" },
      { effect: "deny", risk: "low", matchedRuleIds: [], reasonCode: "capability_ceiling", freshHumanRequired: false, policyVersion: 1 });
    expect(capabilityDeny.error).toBe("capability_denied:capability_ceiling");
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

  it("persists cancellation and timeout as distinct terminal states", async () => {
    for (const [message, expectedStatus] of [
      ["tool_cancelled", "cancelled"],
      ["tool_timed_out", "timed_out"],
    ] as const) {
      const tool: ToolDefinition = {
        name: "run_shell",
        description: "command",
        generation: 1,
        capability: "workspace_write",
        risk: "destructive",
        idempotency: "non_idempotent",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          throw new Error(message);
        },
      };
      const db = openDb(":memory:");
      const executor = new ToolExecutor(db, new ToolRegistry([tool]), new ApprovalManager(db));
      const context: ToolContext = {
        callId: `call-${expectedStatus}`,
        sessionId: "session",
        taskId: "task",
        turnId: "turn",
        agentId: "agent",
        workspaceId: "workspace",
        mode: "single_agent",
        phase: "executing",
        signal: new AbortController().signal,
      };
      const result = await executor.invoke({
        stableKey: `stable-${expectedStatus}`,
        name: "run_shell",
        generation: 1,
        input: {},
        workspaceIdentity: "workspace",
        policyVersion: 1,
      }, context, {
        effect: "allow",
        risk: "destructive",
        matchedRuleIds: [],
        reasonCode: "test",
        freshHumanRequired: false,
        policyVersion: 1,
      });
      expect(result.status).toBe(expectedStatus);
      expect(result.error).toBe(message);
    }
  });

  it("replays a completed destructive call without revalidating changed filesystem state", async () => {
    let exists = true;
    let executions = 0;
    const tool: ToolDefinition = {
      name: "delete_path",
      description: "delete",
      generation: 1,
      capability: "workspace_write",
      risk: "destructive",
      idempotency: "non_idempotent",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      validateInput() {
        return exists ? [] : ["workspace_path_not_found"];
      },
      async execute() {
        executions += 1;
        exists = false;
        return { action: "deleted" };
      },
    };
    const db = openDb(":memory:");
    const executor = new ToolExecutor(db, new ToolRegistry([tool]), new ApprovalManager(db));
    const context: ToolContext = {
      callId: "delete-call",
      sessionId: "session",
      taskId: "task",
      turnId: "turn",
      agentId: "agent",
      workspaceId: "workspace",
      mode: "single_agent",
      phase: "executing",
      signal: new AbortController().signal,
    };
    const request = {
      stableKey: "delete-stable",
      name: "delete_path",
      generation: 1,
      input: { path: "file.txt" },
      workspaceIdentity: "workspace",
      policyVersion: 1,
    };
    const permission: PermissionEvaluation = {
      effect: "allow",
      risk: "destructive",
      matchedRuleIds: [],
      reasonCode: "test",
      freshHumanRequired: false,
      policyVersion: 1,
    };

    const first = await executor.invoke(request, context, permission);
    tool.generation = 2;
    const replay = await executor.invoke(request, context, permission);
    expect(first.status).toBe("succeeded");
    expect(replay.id).toBe(first.id);
    expect(executions).toBe(1);
  });
});
