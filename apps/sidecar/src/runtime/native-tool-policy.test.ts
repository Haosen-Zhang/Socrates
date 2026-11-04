import { expect, it } from "bun:test";
import { StructuredExecutionError, type PermissionEvaluation, type RuntimeEvent, type ToolDefinition } from "@socrates/core";
import type { streamText } from "ai";
import { openDb } from "../db";
import { ApprovalManager } from "../approvals/manager";
import { ConversationMemoryStore } from "../store/conversation-memory-store";
import { ToolExecutor } from "../tools/executor";
import { ToolRegistry } from "../tools/registry";
import { repairToolHistory } from "../tools/repair-history";
import { createAiSdkNativeStream, NativeAgentRuntime, toAiSdkModelMessages, validateNativeToolInput, type NativeStreamFactory } from "./native-agent-runtime";

const allow: PermissionEvaluation = { effect: "allow", risk: "high", matchedRuleIds: [], reasonCode: "room_allow", freshHumanRequired: false, policyVersion: 3 };
function setup(definition: ToolDefinition, stream: NativeStreamFactory, permission = allow, maxBytes = 64 * 1024) {
  const db = openDb(":memory:");
  db.query("INSERT INTO sessions (id, title, mode, status, created_at, updated_at) VALUES ('s', 'S', 'single_agent', 'idle', 'now', 'now')").run();
  const registry = new ToolRegistry([definition]);
  const runtime = new NativeAgentRuntime({ sessionId: "s", taskId: "task", agentId: "a", workspaceId: crypto.randomUUID(), workspaceIdentity: "identity", registry,
    executor: new ToolExecutor(db, registry, new ApprovalManager(db), { maxBytes, maxLines: 100 }), stream,
    permissionForTool: () => permission, allowedCapabilities: ["shell", "workspace_read", "workspace_write"],
  });
  return { db, runtime };
}
const command: ToolDefinition = { name: "verify", description: "test", generation: 1, inputSchema: { type: "object", additionalProperties: false },
  capability: "shell", risk: "high", idempotency: "non_idempotent" };

it("requires fresh exact approval for project commands even under room allow", async () => {
  let effects = 0;
  const s = setup({ ...command, async execute() { effects++; return "verified"; } }, async function* (input) {
    const native = input.tools.verify!;
    const permission = native.permission();
    const request = { requestId: "approval", callId: "first", name: "verify", input: {}, permission };
    yield { type: "tool_call", callId: "first", name: "verify", input: {} };
    const decision = input.requestApproval(request);
    yield { type: "approval_required", ...request };
    if ((await decision).approved) {
      const output = await native.execute({}, "first", permission);
      yield { type: "tool_result", callId: "first", name: "verify", output, isError: false };
      await native.execute({}, "second", permission);
    }
  });
  await s.runtime.open();
  const iterator = s.runtime.start({ prompt: "verify" })[Symbol.asyncIterator]();
  await iterator.next(); await iterator.next();
  expect((await iterator.next()).value).toMatchObject({ type: "approval_required", freshHumanRequired: true });
  expect(effects).toBe(0);
  await expect(s.runtime.answerApproval("approval", "allow_session")).rejects.toThrow("native_tool_fresh_approval_required");
  await s.runtime.answerApproval("approval", "allow_once");
  expect((await iterator.next()).value).toMatchObject({ type: "tool_result" });
  await expect(iterator.next()).rejects.toThrow("native_tool_approval_missing");
  expect(effects).toBe(1);
  s.db.close();
});

it("preserves an explicit shell denial instead of converting it into an approval request", async () => {
  let effect: string | undefined;
  let ran = false;
  const s = setup({ ...command, async execute() { ran = true; } }, async function* ({ tools }) {
    effect = tools.verify!.permission().effect;
    await expect(tools.verify!.execute({}, "call", tools.verify!.permission())).rejects.toThrow("native_tool_permission_denied");
    yield { type: "text_delta", text: "denied" };
  }, { ...allow, effect: "deny" });
  await s.runtime.open();
  for await (const _ of s.runtime.start({ prompt: "verify" })) { /* drain */ }
  expect(effect).toBe("deny"); expect(ran).toBe(false);
  s.db.close();
});

it("classifies Native input validation with the same structured tool error contract", () => {
  let error: unknown;
  try { validateNativeToolInput({ ...command, inputSchema: { type: "object", required: ["path"] } }, {}); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(StructuredExecutionError);
  expect((error as StructuredExecutionError).detail).toMatchObject({ code: "TOOL_INPUT_INVALID", category: "tool_validation", retryable: false, message: "invalid_tool_input:missing:path" });
});

it("forwards canonical failure output and full references through SDK sampling and repaired history", async () => {
  let sampleNo = 0;
  let secondMessages: unknown;
  const stream = createAiSdkNativeStream({} as never, ((input) => {
    const current = ++sampleNo;
    if (current === 2) secondMessages = input.messages;
    return { fullStream: (async function* () {
      if (current > 1) { yield { type: "text-delta", text: "examined" }; return; }
      yield { type: "tool-call", toolCallId: "failed", toolName: "verify", input: {} };
      try { await (input.tools!.verify!.execute as (input: unknown, options: { toolCallId: string; messages: []; context: unknown }) => Promise<unknown>)({}, { toolCallId: "failed", messages: [], context: {} }); }
      catch (error) { yield { type: "tool-error", toolCallId: "failed", toolName: "verify", error }; }
    })(), responseMessages: Promise.resolve(current === 1 ? [{ role: "tool", content: [{ type: "tool-result", toolCallId: "failed", toolName: "verify", output: { type: "error-text", value: "bare error" } }] }] : []), steps: Promise.resolve([{}]) } as never;
  }) as typeof streamText);
  const s = setup({ ...command, capability: "workspace_read", async execute() {
    const error = new StructuredExecutionError({ code: "VALIDATION_FAILED", category: "tool_execution", phase: "tool_execution", retryable: false, message: "validation failed" });
    Object.assign(error, { result: { stderrPreview: "useful failure output ".repeat(200) } });
    throw error;
  } }, stream, allow, 120);
  await s.runtime.open();
  const events: RuntimeEvent[] = [];
  for await (const event of s.runtime.start({ prompt: "verify" })) events.push(event);
  const output = events.find((event) => event.type === "tool_result");
  expect(output).toMatchObject({ type: "tool_result", isError: true, output: { truncated: true } });
  const ref = output?.type === "tool_result" ? output.output.storageKey! : "";
  expect(sampleNo).toBe(2);
  expect(ref).toMatch(/^tool-result:/);
  expect(JSON.stringify(secondMessages)).toContain(ref);
  expect(JSON.stringify(secondMessages)).toContain("VALIDATION_FAILED");

  const memory = new ConversationMemoryStore(s.db);
  const thread = memory.ensureDefaultThread("s");
  s.db.query("INSERT INTO agent_runs (id, session_id, prompt, status, created_at, turn_id, thread_id) VALUES ('task', 's', 'verify', 'failed', 'now', 'task', ?)").run(thread.id);
  await repairToolHistory(s.db, memory, thread.id);
  const repaired = await memory.listThreadMessages(thread.id);
  const result = repaired.flatMap((message) => message.parts).find((part) => part.type === "tool_result");
  expect(result).toMatchObject({ type: "tool_result", isError: true, output: { storageKey: ref } });
  expect(JSON.stringify(toAiSdkModelMessages(repaired))).toContain(ref);
  s.db.close();
});

it("stops later model activity after an unresolved tool even when the SDK swallows its error", async () => {
  let release!: () => void;
  let nextSample = false;
  const s = setup({ ...command, capability: "workspace_read", timeoutMs: 5, async execute() { await new Promise<void>((resolve) => { release = resolve; }); return "late"; } }, async function* ({ tools }) {
    try { await tools.verify!.execute({}, "unresolved", tools.verify!.permission()); } catch { /* SDK normalizes failures. */ }
    yield { type: "provider_step_completed" };
    nextSample = true;
    yield { type: "text_delta", text: "unsafe continuation" };
  });
  await s.runtime.open();
  let error: unknown;
  try { for await (const _ of s.runtime.start({ prompt: "verify" })) { /* drain */ } } catch (caught) { error = caught; }
  release(); await Bun.sleep(10);
  expect(error).toBeInstanceOf(StructuredExecutionError);
  expect((error as StructuredExecutionError).detail.code).toBe("TOOL_EXECUTION_UNRESOLVED");
  expect(nextSample).toBe(false);
  expect(s.db.query("SELECT status FROM tool_calls WHERE id = 'unresolved'").get()).toEqual({ status: "running" });
  s.db.close();
});
