import { Hono } from 'hono';
import { z } from 'zod';
import type { AgentLifecycleService } from '../services/agent-lifecycle';
export function agentLifecycleRoutes(service:AgentLifecycleService){
 const app=new Hono();
 app.get('/:id',c=>{
  const parsed=z.object({after:z.string().max(600).optional(),limit:z.coerce.number().int().min(1).max(100).default(20)}).safeParse(c.req.query());
  if(!parsed.success)return c.json({error:'agent_lifecycle_cursor_invalid'},400);
  const result=service.detail(c.req.param('id'),parsed.data.after,parsed.data.limit);
  return result?c.json(result):c.json({error:'agent_not_found'},404);
 });
 return app;
}
