import { expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupCostFlowFixture, untilCostFlow } from './cost-flow-fixture';

test('unsupported root graph blocks child HTTP plan/replan/verification and tool approval before mutations',async()=>{
 const f=await setupCostFlowFixture({routingFixture:true});
 try {
  const room=f.sessions.get(f.roomIds.work)!;
  f.sessions.updateCollaboration(room.id,{...room.collaboration,strategy:'adaptive',planConfirmation:{...room.collaboration.planConfirmation,reviewerAgentId:'fixture-c'},assignment:{...room.collaboration.assignment,routing:{...room.collaboration.assignment.routing,automaticPolicy:'quality'}}});
  writeFileSync(join(f.workspace.canonicalPath,'security.md'),'controlled review');
  const draft=f.verification.prepare({roomId:room.id,requestId:'check',artifactPaths:['result.txt'],protectedPaths:[],checks:[{id:'exists',kind:'file',path:'result.txt',label:'check',required:true,origin:'user'}]});
  f.verification.approve(draft.id,'approve-check');
  const input={verificationPlanId:draft.id,maxOutputTokens:256,roomId:room.id,content:'Deliver security.md review',intent:'execute' as const,mentions:[]};
  const selected=f.routes.preview(input).candidates.find(c=>c.workflow==='execute_review'&&c.feasible&&!c.fallbackOnly)!;
  expect(selected).toBeDefined();
  const requested={...input,routingCandidateId:selected.id},quote=f.quotes.quote(requested);
  const command=await f.commands.submit({...requested,quoteId:quote.id,clientRequestId:'unsupported-child'});
  await untilCostFlow(()=>f.adaptive.get(command.commandId)?.status==='awaiting_plan','old-graph-plan');
  const child=f.adaptive.get(command.commandId)!.attempts.at(-1)!.child!,plan=f.tasks.getPlan(child.id)!;
  f.db.query("UPDATE adaptive_workflows SET state_json=json_set(state_json,'$.version','future-graph') WHERE root_task_id=?").run(command.commandId);
  const tables=['plan_decisions','plan_versions','approval_decisions','verification_runs','verification_requests','tool_calls','cost_actions'];
  const snapshot=()=>Object.fromEntries(tables.map(t=>[t,f.db.query(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
  f.db.query("INSERT INTO approval_requests(id,task_id,kind,subject_id,input_hash,workspace_identity,attempt_id,policy_version,risk,fresh_human_required,status,created_at,session_id) VALUES('future-tool',?,'tool',?,'hash','workspace','attempt',1,'low',1,'pending','now',?)").run(child.id,`${child.id}:tool`,room.id);
  const before=snapshot(), calls=f.nativeCalls.length;
  for(const decision of ['approve_exact_plan','request_replan','edit_and_approve']) {
   const response=await f.app.request(`/multi/tasks/${child.id}/plan-decisions`,{method:'POST',headers:f.headers,body:JSON.stringify({version:plan.version,hash:plan.contentHash,decision,content:plan.content,clientDecisionKey:decision})});
   expect(response.status).toBe(400);expect(await response.json()).toMatchObject({error:'adaptive_workflow_version_incompatible'});
   expect(snapshot()).toEqual(before);expect(f.nativeCalls.length).toBe(calls);expect(existsSync(join(f.workspace.canonicalPath,'result.txt'))).toBe(false);
  }
  const bound=f.verification.view({roomId:room.id,rootTaskId:command.commandId}).plan!;
  const actions=[
   [`/cost/tasks/${command.commandId}/resume`,{requestId:'future-budget-resume'}],
   ['/verification/run',{target:bound.target,requestId:'future-run'}],
   ['/verification/accept',{target:bound.target,requestId:'future-accept'}],
   [`/verification/plans/${bound.id}/approve`,{requestId:'future-verify-approve'}],
   [`/verification/plans/${bound.id}/baseline`,{requestId:'future-baseline'}],
   ['/multi/approvals/future-tool/decision',{decision:'allow_once',clientDecisionKey:'future-tool-key'}],
  ] as const;
  for(const [path,body] of actions){const response=await f.app.request(path,{method:'POST',headers:f.headers,body:JSON.stringify(body)});expect(response.status).toBe(409);expect(await response.json()).toMatchObject({error:'adaptive_workflow_version_incompatible'});expect(snapshot()).toEqual(before);expect(f.nativeCalls.length).toBe(calls);}
  expect(f.db.query("SELECT status FROM approval_requests WHERE id='future-tool'").get()).toEqual({status:'pending'});
  expect(existsSync(join(f.workspace.canonicalPath,'result.txt'))).toBe(false);
  const cancelled=await f.app.request(`/multi/tasks/${child.id}/cancel`,{method:'POST',headers:f.headers});
  expect(cancelled.status).toBe(200);expect(f.adaptive.get(command.commandId)?.status).toBe('cancelled');expect(f.nativeCalls.length).toBe(calls);
 }finally{await f.close();}
},20000);
