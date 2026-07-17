import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ApprovalDecision, RuntimeEvent } from "@socrates/core";
import type { ApprovalManager } from "../approvals/manager";
import type { SingleAgentRunner } from "../runtime/single-agent-runner";

const DECISIONS = new Set<ApprovalDecision>(["allow_once", "allow_session", "deny"]);

export function agentRunRoutes(runner: SingleAgentRunner, approvals: ApprovalManager): Hono {
  const app = new Hono();
  app.post("/sessions/:sessionId/runs", async (c) => {
    const body = await c.req.json().catch(() => null) as { prompt?: unknown; attachmentIds?: unknown; workspaceRefIds?: unknown; runtimeKind?: unknown; runtimeOptions?: unknown } | null;
    if (typeof body?.prompt !== "string" || !body.prompt.trim()) return c.json({ error: "prompt_required" }, 400);
    const runtimeKind = typeof body.runtimeKind === "string" ? body.runtimeKind : "codex_app_server";
    return streamSSE(c, async (stream) => {
      const emit = async (event: RuntimeEvent) => {
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      };
      const result = await runner.run({
        sessionId: c.req.param("sessionId"),
        runtimeKind,
        prompt: body.prompt as string,
        attachmentIds: Array.isArray(body.attachmentIds) && body.attachmentIds.every((id) => typeof id === "string") ? body.attachmentIds as string[] : [],
        workspaceRefIds: Array.isArray(body.workspaceRefIds) && body.workspaceRefIds.every((id) => typeof id === "string") ? body.workspaceRefIds as string[] : [],
        signal: c.req.raw.signal,
        runtimeOptions: body.runtimeOptions && typeof body.runtimeOptions === "object" ? body.runtimeOptions as Record<string, unknown> : undefined,
      }, emit);
      await stream.writeSSE({ event: "run_terminal", data: JSON.stringify(result) });
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
      await runner.cancel(c.req.param("id"));
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "cancel_failed" }, 409);
    }
  });
  return app;
}
