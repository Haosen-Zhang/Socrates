import type { Database } from 'bun:sqlite';
import { ADAPTIVE_WORKFLOW_VERSION } from '@socrates/core';

/** Resolve durable child ownership, never a caller-supplied room-wide guess. */
export function assertTaskWorkflowCompatible(db: Database, taskId: string): void {
 if (!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='adaptive_workflows'").get()) return;
 const queue=[taskId], seen=new Set<string>();
 while(queue.length) {
  const id=queue.pop()!; if(seen.has(id))continue;seen.add(id);
  const root=db.query<{state_json:string},[string]>('SELECT state_json FROM adaptive_workflows WHERE root_task_id=?').get(id);
  if(root && JSON.parse(root.state_json).version!==ADAPTIVE_WORKFLOW_VERSION)throw new Error('adaptive_workflow_version_incompatible');
  const parents=db.query<{id:string|null},[string,string,string,string,string,string]>(`
   SELECT root_task_id id FROM adaptive_attempts WHERE json_extract(attempt_json,'$.child.id')=?
   UNION SELECT json_extract(config_json,'$.costRootTaskId') FROM multi_tasks WHERE id=?
   UNION SELECT task_id FROM work_packages WHERE run_id=?
   UNION SELECT root_task_id FROM verification_runs WHERE id=?
   UNION SELECT root_task_id FROM cost_invocations WHERE run_id=?
   UNION SELECT a.root_task_id FROM agent_runs r JOIN conversation_turns t ON t.id=r.turn_id JOIN adaptive_attempts a ON json_extract(a.attempt_json,'$.clientTurnKey')=t.client_turn_key WHERE r.id=?
  `).all(id,id,id,id.startsWith('verification:')?id.slice(13):id,id,id);
  for(const parent of parents)if(parent.id&&!seen.has(parent.id))queue.push(parent.id);
 }
}
