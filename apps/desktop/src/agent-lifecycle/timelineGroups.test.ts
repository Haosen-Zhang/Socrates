import {test,expect} from 'bun:test';
import type {FlightRecord} from '@socrates/core';
import {timelineGroups} from './timelineGroups';
test('current snapshots are separate from ordered immutable events and attempts never merge',()=>{
 const r=(id:string,source:string,runId:string,attemptNo:number,sequence:number):FlightRecord=>({id,source,fields:{runId,attemptNo},sequence,rootTaskId:'root',roomId:'room',sourceSequence:sequence,stage:'run',type:'run.created',agentId:'a',occurredAt:'2026-11-11T00:00:00Z',traceId:'trace',spanId:'span',version:1,parentId:null});
 const groups=timelineGroups([r('snapshot','run','r1',1,1),r('created','runtime','r1',1,2),r('failed','runtime','r1',1,3),r('retry','runtime','r2',2,4)]);
 expect(groups).toHaveLength(2);expect(groups[0]!.snapshots.map(r=>r.id)).toEqual(['snapshot']);expect(groups[0]!.events.map(r=>r.id)).toEqual(['created','failed']);expect(groups[1]!.attemptNo).toBe('2');
});
