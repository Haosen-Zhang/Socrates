import {Hono} from 'hono';
import {z} from 'zod';
import type {ArenaArtifactService} from '../services/arena-artifacts';
export function arenaArtifactRoutes(service:ArenaArtifactService){
 const app=new Hono();app.onError((error,c)=>c.json({error:error.message},409));
 app.post('/preview',async c=>{const b=z.object({experimentId:z.string(),trialId:z.string()}).parse(await c.req.json());return c.json(service.diff(b.experimentId,b.trialId));});
 app.post('/apply',async c=>{const b=z.object({experimentId:z.string(),trialId:z.string(),previewHash:z.string(),paths:z.array(z.string()).min(1).max(100),requestId:z.string(),confirmed:z.literal(true)}).parse(await c.req.json());return c.json(service.apply(b));});
 return app;
}
