import type {FlightRecord} from '@socrates/core';
const journalSources=new Set(['event','command-event','runtime']);
export function timelineGroups(records:FlightRecord[]){
 const groups=new Map<string,{id:string;attemptNo:string;workPackageId:string|null;snapshots:FlightRecord[];events:FlightRecord[]}>();
 for(const record of records){
  const id=String(record.fields.runId??record.fields.workPackageId??record.rootTaskId);
  const group=groups.get(id)??{id,attemptNo:'',workPackageId:null,snapshots:[],events:[]};
  if(record.fields.attemptNo!=null&&['run','runtime','package'].includes(record.source))group.attemptNo=String(record.fields.attemptNo);
  if(typeof record.fields.workPackageId==='string')group.workPackageId=record.fields.workPackageId;
  (journalSources.has(record.source)?group.events:group.snapshots).push(record);
  groups.set(id,group);
 }
 return [...groups.values()];
}

/** Independent durable journals have no shared execution clock or sequence. */
export function timelineEventStreams(events:FlightRecord[]){
 const streams=new Map<string,FlightRecord[]>();
 for(const event of events){const stream=streams.get(event.source)??[];stream.push(event);streams.set(event.source,stream);}
 return [...streams].map(([source,records])=>({source,records}));
}
