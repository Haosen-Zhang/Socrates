import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  COLLABORATION_RUNTIME_CAPABILITIES,
  TOOL_APPROVAL_CAPABILITIES,
  type ApprovalDecision,
  type RuntimeEvent,
} from "@socrates/core";
import type { ApprovalManager } from "../approvals/manager";
import type { RunSupervisor } from "../runtime/run-supervisor";
import type { SingleAgentRunner } from "../runtime/single-agent-runner";

const DECISIONS = new Set<ApprovalDecision>(["allow_once", "allow_session", "deny"]);

export function agentRunRoutes(
  supervisor: RunSupervisor,
  runner: SingleAgentRunner,
  approvals: ApprovalManager,
): Hono {
  const app = new Hono();
  app.get("/capabilities", (c) => c.json({
    approvalPolicy: TOOL_APPROVAL_CAPABILITIES,
    collaboration: COLLABORATION_RUNTIME_CAPABILITIES,
  }));
  app.post("/sessions/:sessionId/runs", async (c) => {
    const body = await c.req.json().catch(() => null) as {
      prompt?: unknown;
      threadId?: unknown;
      clientTurnKey?: unknown;
      attachmentIds?: unknown;
      workspaceRefIds?: unknown;
      runtimeKind?: unknown;
      runtimeOptions?: unknown;
    } | null;
    if (typeof body?.prompt !== "string" || !body.prompt.trim()) return c.json({ error: "prompt_required" }, 400);
    const runtimeKind = typeof body.runtimeKind === "string" ? body.runtimeKind : "native_ai_sdk";
    try {
      const started = await supervisor.start({
        sessionId: c.req.param("sessionId"),
        runtimeKind,
        prompt: body.prompt as string,
        threadId: typeof body.threadId === "string" && body.threadId ? body.threadId : undefined,
        clientTurnKey: typeof body.clientTurnKey === "string" && body.clientTurnKey
          ? body.clientTurnKey
          : undefined,
        attachmentIds: Array.isArray(body.attachmentIds) && body.attachmentIds.every((id) => typeof id === "string") ? body.attachmentIds as string[] : [],
        workspaceRefIds: Array.isArray(body.workspaceRefIds) && body.workspaceRefIds.every((id) => typeof id === "string") ? body.workspaceRefIds as string[] : [],
        runtimeOptions: {},
      });
      return c.json(started, 202);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "agent_run_start_failed" }, 409);
    }
  });
  app.get("/runs/:id", (c) => {
    const run = supervisor.get(c.req.param("id"));
    return run ? c.json(run) : c.json({ error: "agent_run_not_found" }, 404);
  });
  app.get("/runs/:id/events", (c) => {
    let resolveWriter!: (writer: (event: RuntimeEvent) => Promise<void>) => void;
    const writer = new Promise<(event: RuntimeEvent) => Promise<void>>((resolve) => {
      resolveWriter = resolve;
    });
    let observation;
    try {
      observation = supervisor.observe(c.req.param("id"), async (event) => {
        await (await writer)(event);
      });
    } catch (error) {
      return c.json({
        error: error instanceof Error ? error.message : "agent_run_observe_failed",
      }, 404);
    }
    return streamSSE(c, async (stream) => {
      resolveWriter(async (event) => {
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      });
      try {
        const disconnected = new Promise<null>((resolve) => {
          if (c.req.raw.signal.aborted) resolve(null);
          else c.req.raw.signal.addEventListener("abort", () => resolve(null), { once: true });
        });
        const result = await Promise.race([
          observation.completion,
          disconnected,
          observation.closed.then(() => null),
        ]);
        if (!result) return;
        await observation.drained();
        if (observation.isClosed()) return;
        await stream.writeSSE({ event: "run_terminal", data: JSON.stringify(result) });
      } finally {
        observation.detach();
      }
    });
  });
  app.get("/approvals", (c) => c.json(approvals.recoverPending().pending));
  app.post("/approvals/:id/decision", async (c) => {
    const body = await c.req.json().catch(() => null) as { decision?: unknown; clientDecisionKey?: unknown; reason?: unknown } | null;
    if (!body || typeof body.decision !== "string" || !DECISIONS.has(body.decision as ApprovalDecision) || typeof body.clientDecisionKey !== "string") {
      return c.json({ error: "invalid_approval_decision" }, 400);
    }
    try {
      return c.json(await runner.decide(c.req.param("id"), {
        decision: body.decision as ApprovalDecision,
        clientDecisionKey: body.clientDecisionKey,
        reason: typeof body.reason === "string" ? body.reason : undefined,
      }));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "approval_decision_failed" }, 409);
    }
  });
  app.post("/runs/:id/cancel", async (c) => {
    try {
      await supervisor.cancel(c.req.param("id"));
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "cancel_failed" }, 409);
    }
  });
  return app;
}
