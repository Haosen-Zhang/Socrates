import { expect, it } from "bun:test";
import type { ToolContext } from "@socrates/core";
import { assertToolExecutionQuiescent, withToolDeadline } from "./tool-deadline";

const context = (signal = new AbortController().signal): ToolContext => ({
  callId: crypto.randomUUID(), sessionId: crypto.randomUUID(), taskId: "run", turnId: "turn", agentId: "agent",
  mode: "single_agent", phase: "executing", signal,
});

it("derives a per-attempt timeout signal and waits for cooperative cleanup", async () => {
  let cleaned = false;
  await expect(withToolDeadline(context(), 10, async ({ signal }) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
      setTimeout(() => { cleaned = true; resolve(); }, 10);
    }, { once: true }));
    return "late";
  })).rejects.toMatchObject({ detail: { code: "TOOL_TIMEOUT", retryable: false } });
  expect(cleaned).toBe(true);
});

it("never dispatches an already cancelled attempt", async () => {
  const controller = new AbortController(); controller.abort();
  let effects = 0;
  await expect(withToolDeadline(context(controller.signal), 100, async () => { effects++; }))
    .rejects.toMatchObject({ detail: { code: "TOOL_CANCELLED" } });
  expect(effects).toBe(0);
});

it("blocks continuing the workspace while a noncooperative timed-out body is unresolved", async () => {
  const ctx = context();
  let release!: () => void;
  const body = new Promise<void>((resolve) => { release = resolve; });
  await expect(withToolDeadline(ctx, 5, async () => body))
    .rejects.toMatchObject({ detail: { code: "TOOL_EXECUTION_UNRESOLVED" } });
  expect(() => assertToolExecutionQuiescent(ctx)).toThrow("tool_execution_still_running");
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(() => assertToolExecutionQuiescent(ctx)).not.toThrow();
});
