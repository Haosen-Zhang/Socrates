import type {Database} from 'bun:sqlite';
import {posix} from 'node:path';
import type {ToolCapability} from '@socrates/core';
/** Host-owned trial rules are reapplied at execution, independently of approval. */
export function arenaToolBoundary(db:Database,roomId:string,capability:ToolCapability,input:unknown):{denial?:string;protectedPaths?:string[]}{
 const row=db.query<{trial_json:string;experiment_json:string},[string]>('SELECT t.trial_json,e.experiment_json FROM arena_trials t JOIN arena_experiments e ON e.id=t.experiment_id WHERE t.room_id=?').get(roomId);
 if(!row)return {};
 if(capability==='mcp'||capability==='network')return {denial:'arena_external_tool_denied'};
 const trial=JSON.parse(row.trial_json),experiment=JSON.parse(row.experiment_json);
 const task=experiment.definition.tasks.find((t:{id:string})=>t.id===trial.taskId);
 if(!task)return {denial:'arena_definition_missing'};
 const protectedPaths=(task.protectedPaths as string[]).map(p=>posix.normalize(p));
 if(protectedPaths.some(p=>p.startsWith('/')||p==='..'||p.startsWith('../')))return {denial:'arena_protected_path_invalid'};
 if(capability==='workspace_write'&&input&&typeof input==='object'){
  const values=Object.entries(input).filter(([k])=>['path','source','destination','sources'].includes(k)).flatMap(([,v])=>Array.isArray(v)?v:[v]).filter((v):v is string=>typeof v==='string').map(p=>posix.normalize(p));
  if(values.some(p=>protectedPaths.some(q=>p===q||p==='.'||p.startsWith(q+'/')||q.startsWith(p+'/'))))return {denial:'arena_protected_definition'};
 }
 return {protectedPaths};
}
