import { streamSSE } from "hono/streaming";
import type { ExecutionEventStore } from "../store/execution-event-store";
import {Hono} from 'hono';
import {z} from 'zod';
import type {FlightRecorderService} from '../services/flight-recorder';
export function flightRecorderRoutes(service:FlightRecorderService, events?:ExecutionEventStore){const app=new Hono();
 app.onError((error,c)=>c.json({error:error.message},400));
 app.get('/rooms/:roomId/tools/:toolCallId/diff',c=>c.json(service.artifactDiff(c.req.param('roomId'),c.req.param('toolCallId'))));
 app.get('/rooms/:roomId/runs/:runId/events',c=>{
  const roomId=c.req.param('roomId'),runId=c.req.param('runId');
  if(!events||!service.ownsRun(roomId,runId))return c.json({error:'timeline_run_not_found'},404);
  const parsed=z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).safeParse(c.req.query('afterSeq')??0);
  if(!parsed.success||parsed.data>events.latestSeq(runId))return c.json({error:'invalid_execution_event_cursor'},400);
  if(events.hasLegacyEvents(runId))return c.json({error:'execution_event_legacy_run_quarantined'},409);
  return streamSSE(c,async stream=>{
   const controller=new AbortController();stream.onAbort(()=>controller.abort());let cursor=parsed.data;
   try{while(!controller.signal.aborted&&!c.req.raw.signal.aborted&&service.ownsRun(roomId,runId)){
    for(const e of events.listAfter(runId,cursor)){
     cursor=e.seq;
     // Notifications carry identity only; the bounded recorder page owns safe display fields.
     if(e.type!=='runtime.event'||!['text_delta','reasoning_delta'].includes(String((e.payload as {event?:{type:string}}).event?.type)))await stream.writeSSE({id:String(cursor),event:'timeline.invalidate',data:JSON.stringify({runId,seq:cursor,terminal:['run.completed','run.failed','run.cancelled','run.interrupted'].includes(e.type)})});
    }
    if(service.runTerminal(runId)&&cursor>=events.latestSeq(runId))return;
    await events.waitForAppend(runId,cursor,AbortSignal.any([controller.signal,c.req.raw.signal,AbortSignal.timeout(1000)]));
   }}finally{controller.abort();}
  });
 });
 app.get('/rooms/:roomId',c=>{const q=c.req.query();const filter=z.object({rootTaskId:z.string().optional(),runId:z.string().max(300).optional(),after:z.coerce.number().int().min(0).optional(),limit:z.coerce.number().int().min(1).max(200).optional(),stage:z.string().max(100).optional(),agentId:z.string().max(180).optional(),search:z.string().max(200).optional(),minAtomic:z.string().regex(/^(0|[1-9]\d{0,40})$/).optional(),sort:z.enum(['sequence','cost']).optional(),failed:z.enum(['true','false']).optional()}).parse(q);return c.json(service.list(c.req.param('roomId'),{...filter,failed:filter.failed==='true'}));});
 app.get('/rooms/:roomId/export-preview',c=>c.json(service.diagnostics(c.req.param('roomId'),c.req.query('rootTaskId'))));
 app.post('/import-preview',async c=>{const raw=await c.req.text();if(raw.length>8_000_000)return c.json({error:'diagnostic_too_large'},413);return c.json(service.importPreview(JSON.parse(raw)));});
 app.post('/rooms/:roomId/retention',async c=>c.json(service.retention(c.req.param('roomId'),z.object({days:z.number().int(),maxEvents:z.number().int()}).strict().parse(await c.req.json()))));
 return app;
}
