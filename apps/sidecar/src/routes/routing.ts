import { Hono } from "hono";
import { z } from "zod";
import type { AdaptiveWorkflowService } from "../services/adaptive-workflow";
import type { RoutePolicyService } from "../services/route-policy";

const request=z.object({requestId:z.string().min(1).max(300)});
const preview=z.object({roomId:z.string().min(1),content:z.string(),intent:z.enum(["respond","discuss","execute"]),
  mentions:z.array(z.discriminatedUnion("type",[z.object({type:z.literal("agent"),agentId:z.string()}),z.object({type:z.literal("all")}),z.object({type:z.literal("file"),refId:z.string()})])),
  verificationPlanId:z.string().min(1).optional(),routingCandidateId:z.string().min(1).optional(),maxOutputTokens:z.number().int().min(1).max(32_768).optional(),
  attachmentIds:z.array(z.string()).optional(),workspaceRefIds:z.array(z.string()).optional(),
  budget:z.object({mode:z.enum(["soft_limit","strict_admission","tracking_only"]),limitAtomic:z.string().regex(/^(0|[1-9]\d*)$/)}).optional()});
export function routingRoutes(routes:Pick<RoutePolicyService,"get"|"preview">,workflows:AdaptiveWorkflowService):Hono {
  const app=new Hono();
  const failure=(error:unknown)=>({error:error instanceof Error?error.message:"routing_request_failed"});
  app.post("/preview",async c=>{
    const parsed=preview.safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json({error:"routing_preview_invalid"},400);
    try{return c.json(routes.preview(parsed.data));}catch(error){return c.json(failure(error),409);}
  });
  app.get("/tasks/:rootTaskId",c=>{
    const rootTaskId=c.req.param("rootTaskId"),decision=routes.get(rootTaskId),workflow=workflows.get(rootTaskId);
    return decision?c.json({decision,workflow}):c.json({error:"routing_decision_not_found"},404);
  });
  app.post("/tasks/:rootTaskId/resume",async c=>{
    const parsed=request.safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json({error:"adaptive_request_invalid"},400);
    try{return c.json(await workflows.resume(c.req.param("rootTaskId"),parsed.data.requestId),202);}catch(error){return c.json(failure(error),409);}
  });
  app.post("/tasks/:rootTaskId/cancel",async c=>{
    const parsed=request.safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json({error:"adaptive_request_invalid"},400);
    try{return c.json(await workflows.cancel(c.req.param("rootTaskId"),parsed.data.requestId));}catch(error){return c.json(failure(error),409);}
  });
  app.post("/approvals/:id/decision",async c=>{
    const parsed=request.extend({decision:z.enum(["allow","deny"])}).safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json({error:"adaptive_decision_invalid"},400);
    try{return c.json(await workflows.decide(c.req.param("id"),parsed.data),202);}catch(error){return c.json(failure(error),409);}
  });
  return app;
}
