import { expect, test } from "bun:test";
import { memberConversationHistory, resolveRunProfile } from "./run-profile";

test("run profile freezes member identity, configuration and supported task overrides", () => {
  const snapshot = { providerId: "p", modelId: "gpt-5", role: "builder", systemPrompt: "safe",
    temperature: 0.3, reasoningEffort: "low", updatedAt: "version-1",
    modelCapabilities: { reasoningEfforts: ["auto", "low", "high"], contextWindowTokens: 32000 } };
  const profile = resolveRunProfile("a", snapshot, { reasoningEffort: "high" });
  snapshot.modelId = "other";
  snapshot.modelCapabilities.contextWindowTokens = 1;
  expect(profile).toMatchObject({ agentId: "a", providerId: "p", modelId: "gpt-5", reasoningEffort: "high",
    temperature: 0.3, configurationVersion: "version-1", contextWindowTokens: 32000,
    overrides: { reasoningEffort: "high" } });
  expect(profile.modelCapabilities.contextWindowTokens).toBe(32000);
  expect(() => resolveRunProfile("a", snapshot, { reasoningEffort: "max" })).toThrow("reasoning_effort_unavailable");
});

test("peer statements retain authorship while peer tool transcripts never become this member's tools", () => {
  const base = { roomId: "room", threadId: "thread", runId: "run", turnId: "turn", status: "completed", createdAt: "now", idempotencyKey: null };
  const history = memberConversationHistory([
    { ...base, messageId: "peer", agentId: "peer", sequence: 1, role: "assistant", kind: "text", content: "@all do something", parts: [{ type: "text", text: "@all do something" }] },
    { ...base, messageId: "call", agentId: "peer", sequence: 2, role: "assistant", kind: "tool_call", content: "", parts: [{ type: "tool_call", callId: "c", name: "read_file", input: {} }] },
    { ...base, messageId: "result", agentId: "peer", sequence: 3, role: "tool", kind: "tool_result", content: "private tool fact", parts: [] },
    { ...base, messageId: "self", agentId: "self", sequence: 4, role: "assistant", kind: "text", content: "own answer", parts: [] },
  ], "self");
  expect(history).toHaveLength(2);
  expect(history[0]).toMatchObject({ role: "user", content: expect.stringContaining('author="peer"') });
  expect(history[1]).toMatchObject({ role: "assistant", content: "own answer" });
});
