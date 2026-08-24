import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  COLLABORATION_RUNTIME_CAPABILITIES,
  TOOL_APPROVAL_CAPABILITIES,
  type ApprovalDecision,
} from "@socrates/core";
import type { ApprovalManager } from "../approvals/manager";
import type { RunSupervisor } from "../runtime/run-supervisor";
import type { SingleAgentRunner } from "../runtime/single-agent-runner";
import type { ExecutionEventStore } from "../store/execution-event-store";

const DECISIONS = new Set<ApprovalDecision>(["allow_once", "allow_session", "deny"]);

export function agentRunRoutes(
  supervisor: RunSupervisor,
  runner: SingleAgentRunner,
  approvals: ApprovalManager,
  events: ExecutionEventStore,
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
    const runId = c.req.param("id");
    const run = supervisor.get(runId);
    if (!run) return c.json({ error: "agent_run_not_found" }, 404);
    const rawCursor = c.req.query("afterSeq") ?? "0";
    if (!/^(0|[1-9]\d*)$/.test(rawCursor)) {
      return c.json({ error: "invalid_execution_event_cursor" }, 400);
    }
    const afterSeq = Number(rawCursor);
    if (!Number.isSafeInteger(afterSeq)) {
      return c.json({ error: "invalid_execution_event_cursor" }, 400);
    }
    if (events.hasLegacyEvents(runId)) {
      return c.json({ error: "execution_event_legacy_run_quarantined" }, 409);
    }
    if (afterSeq > events.latestSeq(runId)) {
      return c.json({ error: "execution_event_cursor_ahead" }, 409);
    }
    return streamSSE(c, async (stream) => {
      let cursor = afterSeq;
      while (!c.req.raw.signal.aborted) {
        const batch = events.listAfter(runId, cursor);
        for (const event of batch) {
          await stream.writeSSE({
            id: String(event.seq),
            event: event.type,
            data: JSON.stringify(event),
          });
          cursor = event.seq;
          if (["run.completed", "run.failed", "run.cancelled", "run.interrupted"]
            .includes(event.type)) return;
        }
        const current = supervisor.get(runId);
        if (!current || ["completed", "failed", "cancelled", "interrupted"]
          .includes(current.status)) return;
        await events.waitForAppend(runId, cursor, c.req.raw.signal);
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
