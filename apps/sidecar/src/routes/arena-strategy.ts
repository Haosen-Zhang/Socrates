import {Hono} from 'hono';
import {z} from 'zod';
import type {ArenaStrategyService} from '../services/arena-strategy';
export function arenaStrategyRoutes(service:ArenaStrategyService){
 const app=new Hono();app.onError((error,c)=>c.json({error:error.message},409));
 app.get('/rooms/:roomId/history',c=>c.json(service.history(c.req.param('roomId'))));
 app.post('/preview',async c=>{const b=z.object({experimentId:z.string(),variantId:z.string()}).parse(await c.req.json());return c.json(service.preview(b.experimentId,b.variantId));});
 app.post('/rooms/:roomId/apply',async c=>{const b=z.object({previewHash:z.string(),requestId:z.string(),confirmed:z.literal(true)}).parse(await c.req.json());return c.json(service.apply(c.req.param('roomId'),b.previewHash,b.requestId,b.confirmed));});
 app.post('/rooms/:roomId/rollback',async c=>{const b=z.object({versionId:z.string(),requestId:z.string()}).parse(await c.req.json());return c.json(service.rollback(c.req.param('roomId'),b.versionId,b.requestId));});
 return app;
}
