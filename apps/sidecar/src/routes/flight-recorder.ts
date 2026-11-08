import {Hono} from 'hono';
import {z} from 'zod';
import type {FlightRecorderService} from '../services/flight-recorder';
export function flightRecorderRoutes(service:FlightRecorderService){const app=new Hono();
 app.onError((error,c)=>c.json({error:error.message},400));
 app.get('/rooms/:roomId',c=>{const q=c.req.query();const filter=z.object({rootTaskId:z.string().optional(),after:z.coerce.number().int().min(0).optional(),limit:z.coerce.number().int().min(1).max(200).optional(),stage:z.string().max(100).optional(),agentId:z.string().max(180).optional(),search:z.string().max(200).optional(),minAtomic:z.string().regex(/^(0|[1-9]\d{0,40})$/).optional(),sort:z.enum(['sequence','cost']).optional(),failed:z.enum(['true','false']).optional()}).parse(q);return c.json(service.list(c.req.param('roomId'),{...filter,failed:filter.failed==='true'}));});
 app.get('/rooms/:roomId/export-preview',c=>c.json(service.diagnostics(c.req.param('roomId'),c.req.query('rootTaskId'))));
 app.post('/import-preview',async c=>{const raw=await c.req.text();if(raw.length>8_000_000)return c.json({error:'diagnostic_too_large'},413);return c.json(service.importPreview(JSON.parse(raw)));});
 app.post('/rooms/:roomId/retention',async c=>c.json(service.retention(c.req.param('roomId'),z.object({days:z.number().int(),maxEvents:z.number().int()}).strict().parse(await c.req.json()))));
 return app;
}
