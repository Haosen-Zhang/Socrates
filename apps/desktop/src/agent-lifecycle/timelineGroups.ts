import type {FlightRecord} from '@socrates/core';
export function timelineGroups(records:FlightRecord[]){
 const groups=new Map<string,{id:string;attemptNo:string;workPackageId:string|null;snapshots:FlightRecord[];events:FlightRecord[]}>();
 for(const record of records){
  const id=String(record.fields.runId??record.fields.workPackageId??record.rootTaskId);
  const group=groups.get(id)??{id,attemptNo:'',workPackageId:null,snapshots:[],events:[]};
  if(record.fields.attemptNo!=null&&['run','runtime','package'].includes(record.source))group.attemptNo=String(record.fields.attemptNo);
  if(typeof record.fields.workPackageId==='string')group.workPackageId=record.fields.workPackageId;
  (['root','run','package','command','attempt'].includes(record.source)?group.snapshots:group.events).push(record);
  groups.set(id,group);
 }
 return [...groups.values()];
}
