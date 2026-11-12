import { WorkItemLaunchService } from '../services/work-item-launch';
import { Hono } from 'hono';
import { WorkItemConflict, WorkItemService } from '../services/work-items';
export function workItemRoutes(service:WorkItemService, launch?:WorkItemLaunchService) {
  const app=new Hono();
  app.onError((e,c)=>c.json({error:e.message},e instanceof WorkItemConflict?409:400));
  app.get('/',c=>c.json(service.list(c.req.query('workspaceId')??'')));
  app.get('/:id',c=>{const item=service.get(c.req.param('id')); return item?c.json(item):c.json({error:'Work item not found'},404);});
  app.post('/',async c=>c.json(service.create(await c.req.json()),201));
  app.put('/:id/assign',async c=>{const b=await c.req.json(); if(!Number.isSafeInteger(b.expectedRevision)||b.expectedRevision<1) throw new Error('Invalid revision'); return c.json(launch ? await launch.assign(c.req.param('id'),b.expectedRevision,b) : service.assign(c.req.param('id'),b.expectedRevision,b));});
  app.post('/:id/review',async c=>{const b=await c.req.json(); if(!Number.isSafeInteger(b.expectedRevision)||b.expectedRevision<1) throw new Error('Invalid revision'); return c.json(service.review(c.req.param('id'),b.expectedRevision,b.decision));});
  app.post('/:id/preview',async c=>{if(!launch)throw new Error('Launch unavailable');return c.json(launch.preview(c.req.param('id'),await c.req.json()));});
  app.post('/:id/requote',async c=>{if(!launch)throw new Error('Launch unavailable');const b=await c.req.json();return c.json(launch.requote(c.req.param('id'),b.previewId,b.verificationPlanId));});
  app.post('/:id/start',async c=>{if(!launch)throw new Error('Launch unavailable');return c.json(await launch.start(c.req.param('id'),await c.req.json()));});
  return app;
}
