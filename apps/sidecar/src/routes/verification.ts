import { Hono } from "hono";
import { z } from "zod";
import type { PrepareVerificationInput } from "@socrates/core";
import type { VerificationService } from "../services/verification-service";

const identifier = z.string().min(1).max(300);
const path = z.string().min(1).max(1_000);
const request = z.object({ requestId: identifier });
const target = z.object({ roomId: identifier, rootTaskId: identifier, workPackageId: identifier.optional() });
const base = { id: z.string().regex(/^[\w.-]{1,80}$/u), label: z.string().min(1).max(300), required: z.boolean(),
  origin: z.enum(["user", "repository", "worker"]).optional(), definitionPaths: z.array(path).max(200).optional() };
const check = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("command"), category: z.enum(["test", "typecheck", "build", "lint"]),
    command: z.object({ executable: z.string().min(1).max(100), argv: z.array(z.string().max(8_192)).max(200), cwd: path.optional(), timeoutMs: z.number().int().min(100).max(120_000).optional() }),
    parser: z.enum(["exit_code", "bun_test", "tap", "junit", "unsupported"]), reportPath: path.optional(), minTests: z.number().int().min(1).max(1_000_000).optional() }),
  z.object({ ...base, kind: z.literal("file"), path, minBytes: z.number().int().min(0).optional(), contains: z.string().max(10_000).optional(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
  z.object({ ...base, kind: z.literal("json_schema"), path, schema: z.record(z.string(), z.unknown()) }),
]);
const prepare = z.object({ roomId: identifier, rootTaskId: identifier.optional(), workPackageId: identifier.optional(), requestId: identifier,
  checks: z.array(check).min(1).max(20), artifactPaths: z.array(path).min(1).max(100), protectedPaths: z.array(path).max(4_000),
  manualJudgment: z.array(z.string().min(1).max(1_000)).max(50).optional(), source: z.enum(["user", "repository", "worker"]).optional() });
const action = z.object({ target, requestId: identifier });

/** Local sidecar authentication is applied by the host, as for other room routes. */
export function verificationRoutes(service: VerificationService): Hono {
  const app = new Hono();
  const failure = (error: unknown) => ({ error: error instanceof Error ? error.message : "verification_request_failed" });
  app.get("/rooms/:roomId/suggestions", c => {
    try { return c.json(service.suggestions(c.req.param("roomId"))); } catch (error) { return c.json(failure(error), 409); }
  });
  app.post("/plans", async c => {
    const parsed = prepare.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "verification_plan_invalid", details: parsed.error.issues }, 400);
    try { return c.json(service.prepare(parsed.data as PrepareVerificationInput), 201); } catch (error) { return c.json(failure(error), 409); }
  });
  app.get("/plans/:id", c => {
    const plan = service.getPlan(c.req.param("id"));
    return plan ? c.json(plan) : c.json({ error: "verification_plan_not_found" }, 404);
  });
  app.post("/plans/:id/approve", async c => {
    const parsed = request.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "verification_request_invalid" }, 400);
    try { return c.json(service.approve(c.req.param("id"), parsed.data.requestId)); } catch (error) { return c.json(failure(error), 409); }
  });
  app.post("/plans/:id/baseline", async c => {
    const parsed = request.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "verification_request_invalid" }, 400);
    try { return c.json(await service.baseline(c.req.param("id"), parsed.data.requestId)); } catch (error) { return c.json(failure(error), 409); }
  });
  app.get("/view", c => {
    const parsed = target.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "verification_target_invalid" }, 400);
    try { return c.json(service.view(parsed.data)); } catch (error) { return c.json(failure(error), 409); }
  });
  app.post("/run", async c => {
    const parsed = action.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "verification_request_invalid" }, 400);
    try { return c.json(await service.verify(parsed.data.target, { requestId: parsed.data.requestId })); } catch (error) { return c.json(failure(error), 409); }
  });
  app.post("/cancel", async c => {
    const parsed = action.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "verification_request_invalid" }, 400);
    try { return c.json(await service.cancel(parsed.data.target, parsed.data.requestId)); } catch (error) { return c.json(failure(error), 409); }
  });
  app.post("/accept", async c => {
    const parsed = action.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "verification_request_invalid" }, 400);
    try { return c.json(service.acceptUnverified(parsed.data.target, parsed.data.requestId)); } catch (error) { return c.json(failure(error), 409); }
  });
  app.post("/approvals/:id/decision", async c => {
    const parsed = request.extend({ decision: z.enum(["allow_once", "deny"]) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "verification_decision_invalid" }, 400);
    try { return c.json(await service.decide(c.req.param("id"), parsed.data)); } catch (error) { return c.json(failure(error), 409); }
  });
  app.get("/evidence/:id/output", c => {
    const parsed = z.object({ roomId: identifier, stream: z.enum(["stdout", "stderr"]), offset: z.coerce.number().int().min(0).default(0) }).safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "verification_output_request_invalid" }, 400);
    try { return c.json(service.readEvidenceOutput(c.req.param("id"), parsed.data.roomId, parsed.data.stream, parsed.data.offset)); } catch (error) { return c.json(failure(error), 409); }
  });
  return app;
}
