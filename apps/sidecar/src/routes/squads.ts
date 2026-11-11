import { Hono } from 'hono';
import { SquadService, SquadConflict, type SquadInput } from '../services/squads';
function input(body:Record<string,unknown>):SquadInput {
  for(const key of ['workspaceId','name','leaderAgentId','description','instructions']) if(typeof body[key]!=='string') throw new Error('Invalid '+key);
  if(body.avatar!==null && typeof body.avatar!=='string') throw new Error('Invalid avatar');
  if(!Array.isArray(body.members) || !body.members.length || body.members.some(m=>!m || typeof m.agentId!=='string' || typeof m.responsibility!=='string')) throw new Error('Invalid members');
  return body as unknown as SquadInput;
}
function revision(value:unknown) { if(!Number.isSafeInteger(value) || (value as number)<1) throw new Error('Invalid expectedRevision'); return value as number; }
export function squadRoutes(service:SquadService) {
  const app=new Hono();
  app.onError((e,c)=>c.json({error:e.message},e instanceof SquadConflict?409:400));
  app.get('/',c=>c.json(service.list(c.req.query('workspaceId')??'')));
  app.get('/rooms/:roomId/binding',c=>c.json(service.binding(c.req.param('roomId'))));
  app.post('/rooms/:roomId/detach',async c=>{const b=await c.req.json();return c.json(service.detach(c.req.param('roomId'),revision(b.expectedBindingVersion)));});
  app.get('/:id/impact',c=>c.json({rooms:service.references(c.req.param('id')),policy:'keep_frozen'}));
  app.get('/:id',c=>{
    const detail=service.detail(c.req.param('id')); return detail?c.json(detail):c.json({error:'Squad not found'},404);
  });
  app.post('/',async c=>c.json(service.create(input(await c.req.json())),201));
  app.put('/:id',async c=>{const b=await c.req.json();return c.json(service.update(c.req.param('id'),revision(b.expectedRevision),input(b)));});
  app.post('/:id/archive',async c=>{const b=await c.req.json();if(b.referencePolicy!=='keep_frozen')throw new Error('Choose keep_frozen to preserve existing rooms');return c.json(service.archive(c.req.param('id'),revision(b.expectedRevision)));});
  app.post('/:id/rooms',async c=>{const b=await c.req.json();if(typeof b.title!=='string')throw new Error('Title required');return c.json(service.createRoom(c.req.param('id'),revision(b.expectedRevision),b.title),201);});
  app.post('/:id/bind',async c=>{const b=await c.req.json();if(typeof b.roomId!=='string' || !(b.expectedBindingVersion===null || Number.isSafeInteger(b.expectedBindingVersion)))throw new Error('Room and expected binding revision required');return c.json(service.bind(c.req.param('id'),revision(b.expectedRevision),b.roomId,b.expectedBindingVersion));});
  return app;
}
