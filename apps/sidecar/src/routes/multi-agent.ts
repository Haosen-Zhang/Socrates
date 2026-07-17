import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { validateStructuredPlan, type ApprovalDecision, type StructuredPlan } from "@socrates/core";
import type { ApprovalManager } from "../approvals/manager";
import type { MultiAgentCoordinator, MultiAgentEvent } from "../multi-agent/coordinator";
import type { MultiTaskConfig, MultiTaskStore } from "../multi-agent/task-store";
import type { ExecutionRunner } from "../runtime/execution-runner";

const TOOL_DECISIONS = new Set<ApprovalDecision>(["allow_once", "allow_session", "deny"]);

export function multiAgentRoutes(store: MultiTaskStore, coordinator: MultiAgentCoordinator, execution: ExecutionRunner, approvals: ApprovalManager): Hono {
  const app = new Hono();
  const taskView = (id: string) => {
    const task = store.get(id);
    if (!task) return null;
    return {
      ...task,
      plan: store.getPlan(id),
      turns: store.listTurns(id),
      outcomeUnknown: store.hasOutcomeUnknown(id),
      requiresExecutionReview: task.terminalReason === "execution_interrupted_requires_review" || (task.state === "paused" && (task.resumeFrom === "executing" || task.resumeFrom === "awaiting_tool_approval")),
      usageSummaries: store.usageSummaries(id),
      pendingApprovals: approvals.recoverPending().pending.filter((item) => item.taskId === id),
    };
  };

  app.get("/sessions/:sessionId/tasks", (c) => c.json(store.list(c.req.param("sessionId"))));
  app.get("/tasks/:id", (c) => {
    const view = taskView(c.req.param("id"));
    return view ? c.json(view) : c.json({ error: "multi_task_not_found" }, 404);
  });
  app.post("/sessions/:sessionId/tasks", async (c) => {
    const body = await c.req.json().catch(() => null) as { prompt?: unknown; config?: unknown } | null;
    if (!body || typeof body.prompt !== "string" || !body.config || typeof body.config !== "object") return c.json({ error: "multi_task_input_invalid" }, 400);
    let task;
    try { task = coordinator.create({ sessionId: c.req.param("sessionId"), prompt: body.prompt, config: body.config as MultiTaskConfig }); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : "multi_task_create_failed" }, 400); }
    return streamSSE(c, async (stream) => {
      const emit = async (event: MultiAgentEvent) => stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      await emit({ type: "task_state", taskId: task.id, state: task.state });
      await coordinator.run(task.id, emit);
    });
  });
  app.post("/tasks/:id/plan-decisions", async (c) => {
    const body = await c.req.json().catch(() => null) as {
      version?: unknown; hash?: unknown; clientDecisionKey?: unknown; decision?: unknown; reason?: unknown; content?: unknown;
    } | null;
    if (!body || typeof body.version !== "number" || typeof body.hash !== "string" || typeof body.clientDecisionKey !== "string" || typeof body.decision !== "string") return c.json({ error: "plan_decision_invalid" }, 400);
    try {
      if (body.decision === "edit_and_approve") {
        if (validateStructuredPlan(body.content).length) return c.json({ error: "structured_plan_invalid" }, 400);
        store.transition(c.req.param("id"), { type: "edit_plan" });
        const plan = await store.addPlan({ taskId: c.req.param("id"), content: body.content as StructuredPlan, createdBy: "user", parentVersion: body.version });
        store.transition(c.req.param("id"), { type: "edited_plan_ready" });
        const decision = store.decidePlan({ taskId: c.req.param("id"), version: plan.version, hash: plan.contentHash, clientDecisionKey: body.clientDecisionKey, decision: "approve_exact_plan", reason: typeof body.reason === "string" ? body.reason : undefined });
        if (!decision.replayed) void execution.run(c.req.param("id")).catch(() => {});
        return c.json({ decision, plan });
      }
      if (!["approve_exact_plan", "request_replan", "reject"].includes(body.decision)) return c.json({ error: "plan_decision_invalid" }, 400);
      const decision = store.decidePlan({ taskId: c.req.param("id"), version: body.version, hash: body.hash, clientDecisionKey: body.clientDecisionKey, decision: body.decision as "approve_exact_plan" | "request_replan" | "reject", reason: typeof body.reason === "string" ? body.reason : undefined });
      if (!decision.replayed && body.decision === "approve_exact_plan") void execution.run(c.req.param("id")).catch(() => {});
      if (!decision.replayed && body.decision === "request_replan") void coordinator.replan(c.req.param("id"), typeof body.reason === "string" ? body.reason : "Please revise the plan.").catch(() => {});
      return c.json(decision);
    } catch (error) {
      const message = error instanceof Error ? error.message : "plan_decision_failed";
      return c.json({ error: message }, message === "plan_hash_mismatch" ? 409 : 400);
    }
  });
  app.post("/approvals/:id/decision", async (c) => {
    const body = await c.req.json().catch(() => null) as { decision?: unknown; clientDecisionKey?: unknown; reason?: unknown } | null;
    if (!body || typeof body.decision !== "string" || !TOOL_DECISIONS.has(body.decision as ApprovalDecision) || typeof body.clientDecisionKey !== "string") return c.json({ error: "invalid_approval_decision" }, 400);
    try { return c.json(await execution.decide(c.req.param("id"), { decision: body.decision as ApprovalDecision, clientDecisionKey: body.clientDecisionKey, reason: typeof body.reason === "string" ? body.reason : undefined })); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : "approval_decision_failed" }, 409); }
  });
  app.post("/tasks/:id/cancel", async (c) => {
    const task = store.get(c.req.param("id"));
    if (!task) return c.json({ error: "multi_task_not_found" }, 404);
    try {
      if (task.state === "executing" || task.state === "awaiting_tool_approval") await execution.cancel(task.id);
      else coordinator.cancel(task.id);
      return c.json({ ok: true });
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : "multi_cancel_failed" }, 409); }
  });
  app.post("/tasks/:id/pause", async (c) => {
    const task = store.get(c.req.param("id"));
    if (!task) return c.json({ error: "multi_task_not_found" }, 404);
    try {
      if (task.state === "executing" || task.state === "awaiting_tool_approval") await execution.pause(task.id);
      else coordinator.pause(task.id);
      return c.json({ ok: true, task: store.get(task.id) });
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : "multi_pause_failed" }, 409); }
  });
  app.post("/tasks/:id/resume", async (c) => {
    const task = store.get(c.req.param("id"));
    if (!task) return c.json({ error: "multi_task_not_found" }, 404);
    if (task.state !== "paused" || !task.resumeFrom) return c.json({ error: "multi_task_not_paused" }, 409);
    try {
      if (task.resumeFrom === "executing" || task.resumeFrom === "awaiting_tool_approval") return c.json({ error: "execution_resume_requires_manual_review" }, 409);
      else await coordinator.resumeInBackground(task.id);
      return c.json({ accepted: true }, 202);
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : "multi_resume_failed" }, 409); }
  });
  app.post("/tasks/:id/retry", async (c) => {
    const task = store.get(c.req.param("id"));
    if (!task) return c.json({ error: "multi_task_not_found" }, 404);
    const body = await c.req.json().catch(() => null) as { confirmOutcomeUnknown?: unknown } | null;
    const executionReview = task.resumeFrom === "executing" || task.resumeFrom === "awaiting_tool_approval";
    if (task.state !== "paused" || (!store.hasOutcomeUnknown(task.id) && !executionReview)) return c.json({ error: "multi_task_retry_not_required" }, 409);
    if (body?.confirmOutcomeUnknown !== true) return c.json({ error: "outcome_unknown_confirmation_required" }, 400);
    try {
      if (executionReview) void execution.resumeAfterReview(task.id).catch(() => {});
      else await coordinator.retryAfterReview(task.id);
      return c.json({ accepted: true }, 202);
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : "multi_retry_failed" }, 409); }
  });
  return app;
}
