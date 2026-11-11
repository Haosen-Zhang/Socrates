import { Hono } from 'hono';
import type { WorkInteractionService } from '../services/work-interactions';
import type { InboxService } from '../services/inbox';
export function interactionRoutes(service:WorkInteractionService,scope:'item'|'room') {
 const app=new Hono();app.onError((e,c)=>c.json({error:e.message},409));
 const target=(id:string)=>scope==='item'?{workItemId:id}:{roomId:id};
 app.get('/:id/interactions',c=>c.json(service.list(target(c.req.param('id')))));
 app.post('/:id/interactions/preview',async c=>c.json(service.preview(target(c.req.param('id')),await c.req.json())));
 app.post('/:id/interactions',async c=>c.json(await service.submit(target(c.req.param('id')),await c.req.json()),202));
 app.post('/:id/interactions/:interactionId/resolve',async c=>c.json(service.resolve(target(c.req.param('id')),c.req.param('interactionId'),(await c.req.json()).decision)));
 app.post('/:id/evaluations/:evaluationId/resolve',async c=>{if(scope!=='item')throw new Error('work_item_required');return c.json(service.resolveEvaluation(c.req.param('id'),c.req.param('evaluationId'),(await c.req.json()).decision));});
 return app;
}
export function inboxRoutes(service:InboxService){const app=new Hono();app.onError((e,c)=>c.json({error:e.message},400));app.get('/',c=>c.json(service.list(c.req.query('workspaceId'))));app.post('/:id/read',async c=>{service.read(c.req.param('id'),(await c.req.json()).revision);return c.json({ok:true});});return app;}
