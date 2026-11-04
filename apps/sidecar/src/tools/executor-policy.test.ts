import { expect, it } from "bun:test";
import type { ToolDefinition, ToolContext, PermissionEvaluation } from "@socrates/core";
import { openDb } from "../db";
import { ApprovalManager } from "../approvals/manager";
import { ToolExecutor } from "./executor";
import { ToolRegistry } from "./registry";

const permission: PermissionEvaluation = { effect: "allow", risk: "low", reasonCode: "test", policyVersion: 1, matchedRuleIds: [], freshHumanRequired: false };
function setup(overrides: Partial<ToolDefinition>) {
  const db = openDb(":memory:");
  const tool: ToolDefinition = { name: "probe", description: "probe", inputSchema: { type: "object" }, generation: 1,
    risk: "low", capability: "workspace_read", idempotency: "read", execute: async () => ({ value: "ok" }), ...overrides };
  const context: ToolContext = { callId: "call", sessionId: crypto.randomUUID(), taskId: "run", turnId: "turn", agentId: "agent",
    workspaceId: "workspace", mode: "single_agent", phase: "executing", signal: new AbortController().signal };
  const executor = new ToolExecutor(db, new ToolRegistry([tool]), new ApprovalManager(db), { maxBytes: 100, maxLines: 100 });
  const invoke = (id = "call", input = {}) => executor.invoke({ stableKey: id, name: "probe", generation: 1, input,
    workspaceIdentity: "identity", policyVersion: 1 }, { ...context, callId: id }, permission);
  return { db, executor, context, invoke };
}

it("rejects malformed canonical output before durable success without retrying", async () => {
  let attempts = 0;
  const s = setup({ outputSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
    execute: async () => { attempts++; return { count: "wrong" }; } });
  const result = await s.invoke();
  expect(result.status).toBe("failed");
  expect(result.output?.preview).toContain("TOOL_OUTPUT_INVALID");
  expect(attempts).toBe(1);
});

it("enforces declared timeout on each attempt and records its structured reason", async () => {
  const s = setup({ timeoutMs: 5, execute: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return "late"; } });
  const result = await s.invoke();
  expect(result.status).toBe("timed_out");
  expect(result.output?.preview).toContain("TOOL_TIMEOUT");
});

it("retains complete canonical output behind a durable bounded preview", async () => {
  const s = setup({ execute: async () => ({ text: "x".repeat(10_000) }) });
  const result = await s.invoke();
  expect(result.output?.truncated).toBe(true);
  expect(result.output).toMatchObject({ storageKey: expect.stringMatching(/^tool-result:/) });
  expect(result.output!.preview.length).toBeLessThan(300);
});

it("advises repeated logical calls at the third request without counting replay", async () => {
  const s = setup({});
  const first = await s.invoke("c1");
  const replay = await s.invoke("c1");
  expect(replay).toEqual(first);
  await s.invoke("c2");
  const third = await s.invoke("c3");
  expect(third.output?.preview).toContain("repeating the exact same tool call");
});

it("preserves a stable workspace failure code and never retries a stale write", async () => {
  let effects = 0;
  const s = setup({ idempotency: "non_idempotent", execute: async () => { effects++; throw new Error("WORKSPACE_FILE_CHANGED"); } });
  const result = await s.invoke();
  expect(result.errorDetail).toMatchObject({ code: "WORKSPACE_FILE_CHANGED", category: "tool_execution", retryable: false });
  expect(effects).toBe(1);
  s.db.close();
});

it("advises at three, five and eight normalized logical calls and resets for different input", async () => {
  const s = setup({});
  for (let index = 1; index <= 8; index++) {
    const result = await s.invoke(`call-${index}`, index % 2 ? { a: 1, b: [2] } : { b: [2], a: 1 });
    expect(result.output!.preview.includes("[Tool guidance]")).toBe([3, 5, 8].includes(index));
    expect(result.status).toBe("succeeded");
  }
  expect((await s.invoke("different", { a: 2 })).output!.preview).not.toContain("[Tool guidance]");
  expect((await s.invoke("reset", { a: 1, b: [2] })).output!.preview).not.toContain("[Tool guidance]");
  s.db.close();
});

it("persists a structured permission denial without dispatching a body", async () => {
  let calls = 0;
  const s = setup({ execute: async () => { calls++; return {}; } });
  const result = await s.executor.invoke({ stableKey: "denied", name: "probe", generation: 1, input: {}, workspaceIdentity: "identity", policyVersion: 1 },
    { ...s.context, callId: "denied" }, { ...permission, effect: "deny", reasonCode: "room_deny" });
  expect(result.errorDetail).toMatchObject({ code: "POLICY_DENIED", category: "permission", retryable: false });
  expect(result.output?.isError).toBe(true);
  expect(calls).toBe(0);
  s.db.close();
});
