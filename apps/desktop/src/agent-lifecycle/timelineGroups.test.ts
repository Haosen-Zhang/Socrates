import {test,expect} from 'bun:test';
import type {FlightRecord} from '@socrates/core';
import {timelineGroups} from './timelineGroups';
test('current snapshots are separate from ordered immutable events and attempts never merge',()=>{
 const r=(id:string,source:string,runId:string,attemptNo:number,sequence:number):FlightRecord=>({id,source,fields:{runId,attemptNo},sequence,rootTaskId:'root',roomId:'room',sourceSequence:sequence,stage:'run',type:'run.created',agentId:'a',occurredAt:'2026-11-11T00:00:00Z',traceId:'trace',spanId:'span',version:1,parentId:null});
 const groups=timelineGroups([r('snapshot','run','r1',1,1),r('created','runtime','r1',1,2),r('failed','runtime','r1',1,3),r('retry','runtime','r2',2,4)]);
 expect(groups).toHaveLength(2);expect(groups[0]!.snapshots.map(r=>r.id)).toEqual(['snapshot']);expect(groups[0]!.events.map(r=>r.id)).toEqual(['created','failed']);expect(groups[1]!.attemptNo).toBe('2');
});

test('snapshot-only pages cannot put tools before Run creation in the execution journal',()=>{
 const r=(id:string,source:string,sequence:number,sourceSequence:number):FlightRecord=>({id,source,fields:{runId:'r',attemptNo:1},sequence,sourceSequence,rootTaskId:'root',roomId:'room',stage:'run',type:id,agentId:'a',occurredAt:'2026-11-11T00:00:00Z',traceId:'trace',spanId:'span',version:1,parentId:'root:root'});
 const pages=[
  [r('tool.write_file','tool',1,1),r('tool.read_file','tool',2,2),r('model.execute','invocation',3,1)],
  [r('approval.allowed','approval',4,1),r('run.completed','run',5,0),r('run.created','runtime',6,1)],
  [r('turn.started','runtime',7,2),r('run.started','runtime',8,3),r('tool.operation.requested','runtime',9,4)],
 ];
 const groups=pages.flatMap(timelineGroups);
 expect(groups.flatMap(g=>g.events).map(r=>r.type)).toEqual(['run.created','turn.started','run.started','tool.operation.requested']);
 expect(groups.flatMap(g=>g.snapshots).map(r=>r.type)).toEqual(['tool.write_file','tool.read_file','model.execute','approval.allowed','run.completed']);
 expect(groups[0]!.events).toHaveLength(0);
});

test('independent journals stay visibly separate instead of claiming a shared chronology',async()=>{
 const {timelineEventStreams}=await import('./timelineGroups');
 const r=(id:string,source:string,sequence:number,sourceSequence:number):FlightRecord=>({id,source,fields:{runId:'r'},sequence,sourceSequence,rootTaskId:'root',roomId:'room',stage:'run',type:id,agentId:'a',occurredAt:'2026-11-11T00:00:00Z',traceId:'trace',spanId:'span',version:1,parentId:null});
 const records=[r('multi.package_finished','event',1,12),r('task.completed','command-event',2,5),r('run.created','runtime',3,1),r('run.started','runtime',4,2),r('run.completed','runtime',5,3)];
 const streams=timelineEventStreams(timelineGroups(records)[0]!.events);
 expect(streams.map(s=>s.source)).toEqual(['event','command-event','runtime']);
 expect(streams.find(s=>s.source==='runtime')!.records.map(r=>r.sourceSequence)).toEqual([1,2,3]);
 expect(streams.find(s=>s.source==='event')!.records.map(r=>r.type)).toEqual(['multi.package_finished']);
});
