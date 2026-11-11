import { writeFileSync, unlinkSync } from 'node:fs';
import { setupCostFlowFixture, untilCostFlow } from '../apps/sidecar/src/services/cost-flow-fixture';

// Only synthetic data and the controlled local provider; no real user store is opened.
let approvalMode=false;
const f = await setupCostFlowFixture({ routingFixture: true, nativeToolCalls: () => approvalMode ? undefined : [] });
f.sessions.rename(f.roomIds.work, 'Lifecycle acceptance lab');
const squad = f.squads.create({ workspaceId: f.workspace.id, name: 'Lifecycle squad', avatar: 'robot', leaderAgentId: 'fixture-a', description: 'Synthetic lifecycle verification', instructions: 'Use approved work packages.', members: [{ agentId: 'fixture-a', responsibility: 'Build' }, { agentId: 'fixture-b', responsibility: 'Review' }, { agentId: 'fixture-c', responsibility: 'Specialist' }] });
f.squads.bind(squad.id, squad.revision, f.roomIds.work, null);
const item = f.workItems.create({ workspaceId: f.workspace.id, roomId: f.roomIds.work, title: 'Inspect a completed run', objective: 'Return a controlled completion', acceptanceCriteria: ['Human reviews the result'], ownerKind: 'agent', ownerId: 'fixture-a', priority: 'normal' });
const preview = f.workItemLaunch.preview(item.id, { expectedRevision: item.revision, ownerKind: 'agent', ownerId: 'fixture-a' });
await f.workItemLaunch.start(item.id, { previewId: preview.id, expectedRevision: item.revision, clientRequestId: 'fixture-completed' });
await untilCostFlow(() => f.workItems.get(item.id)?.workflow === 'in_review', 'initial completed work item');
f.app.post('/__multica/seed-interactions',async c=>{
const teamItem=f.workItems.create({workspaceId:f.workspace.id,title:'Inbox and queue lab',objective:'Plan controlled work and wait for approval',acceptanceCriteria:['Review locally'],ownerKind:'squad',ownerId:squad.id,priority:'normal'});
const teamPreview=f.workItemLaunch.preview(teamItem.id,{expectedRevision:teamItem.revision,ownerKind:'squad',ownerId:squad.id});
await f.workItemLaunch.start(teamItem.id,{previewId:teamPreview.id,expectedRevision:teamItem.revision,clientRequestId:'fixture-team'});
await untilCostFlow(()=>f.workItems.get(teamItem.id)?.currentRun?.commandStatus==='awaiting_plan_approval','team approval');
const restartItem=f.workItems.create({workspaceId:f.workspace.id,title:'Stop and restart lab',objective:'Plan controlled work and wait for approval',acceptanceCriteria:['Review locally'],ownerKind:'squad',ownerId:squad.id,priority:'normal'});
const restartPreview=f.workItemLaunch.preview(restartItem.id,{expectedRevision:restartItem.revision,ownerKind:'squad',ownerId:squad.id});
await f.workItemLaunch.start(restartItem.id,{previewId:restartPreview.id,expectedRevision:restartItem.revision,clientRequestId:'fixture-restart'});
await untilCostFlow(()=>f.workItems.get(restartItem.id)?.currentRun?.commandStatus==='awaiting_plan_approval','restart approval');
return c.json({teamItemId:teamItem.id,restartItemId:restartItem.id,teamRoomId:teamPreview.executionRoomId,restartRoomId:restartPreview.executionRoomId});
});
f.app.post('/__multica/blocked-instruction',async c=>{
 const target=f.workItems.create({workspaceId:f.workspace.id,title:'Blocked instruction lab',objective:'Wait for controlled approval',acceptanceCriteria:['Local review'],ownerKind:'squad',ownerId:squad.id,priority:'normal'});
 const launch=f.workItemLaunch.preview(target.id,{expectedRevision:target.revision,ownerKind:'squad',ownerId:squad.id});
 await f.workItemLaunch.start(target.id,{previewId:launch.id,expectedRevision:target.revision,clientRequestId:'blocked-fixture'});
 await untilCostFlow(()=>f.workItems.get(target.id)?.currentRun?.commandStatus==='awaiting_plan_approval','blocked fixture plan');
 const queued=await f.interactions.submit({workItemId:target.id},{clientRequestId:'blocked-instruction',action:'message',content:'Resolve this blocked instruction without replay.',mentions:[{type:'agent',agentId:'fixture-b'}],delivery:'queue'});
 await f.app.request('/providers/fixture-provider',{method:'PUT',headers:f.headers,body:JSON.stringify({enabled:false})});
 try{await f.commands.cancel(f.workItems.get(target.id)!.currentRun!.commandId!);await untilCostFlow(()=>f.interactions.get(queued.id)?.status==='blocked','disabled-provider queued instruction');}
 finally{await f.app.request('/providers/fixture-provider',{method:'PUT',headers:f.headers,body:JSON.stringify({enabled:true})});}
 return c.json({interactionId:queued.id,itemId:target.id});
});
f.app.post('/__multica/tool-approval',async c=>{
 const source=f.sessions.get(f.roomIds.work)!;
 const room=f.sessions.create({title:'Actual tool approval lab',mode:source.mode,kind:'cowork',workspaceId:f.workspace.id,primaryAgentId:'fixture-a',agents:source.agents.map(a=>({agentId:a.agentId,snapshot:a.snapshot,executionEligible:a.executionEligible}))});
 f.sessions.updateCollaboration(room.id,{...room.collaboration,strategy:'single'});f.sessions.updateApprovalPolicy(room.id,'ask');approvalMode=true;
 const command=await f.interactions.submit({roomId:room.id},{clientRequestId:'actual-write-approval',action:'message',content:'Request a controlled write approval',mentions:[{type:'agent',agentId:'fixture-a'}]});
 await untilCostFlow(()=>f.commands.get(command.commandId!)?.status==='awaiting_approval','actual write approval');
 const entry=f.inbox.list().items.find(i=>i.link.roomId===room.id&&i.link.approvalId)!;
 return c.json({roomId:room.id,commandId:command.commandId,entry});
});
f.app.post('/__multica/adaptive-history',async c=>{
 approvalMode=false;const source=f.sessions.get(f.roomIds.work)!;
 const room=f.sessions.create({title:'Adaptive history lab',mode:source.mode,kind:'cowork',workspaceId:f.workspace.id,primaryAgentId:'fixture-a',agents:source.agents.map(a=>({agentId:a.agentId,snapshot:a.snapshot,executionEligible:a.executionEligible}))});
 f.sessions.updateCollaboration(room.id,source.collaboration);
 const command=await f.commands.submit({roomId:room.id,clientRequestId:'old-planning',content:'Create controlled plan',intent:'execute',mentions:[]});
 await untilCostFlow(()=>f.commands.get(command.commandId)?.status==='awaiting_plan_approval','adaptive original plan');
 const task=f.tasks.get(f.commands.get(command.commandId)!.taskId!)!;const turn=f.db.query<{id:string},[string]>("SELECT id FROM multi_turns WHERE task_id=? AND phase='synthesizing'").get(task.id)!;
 await f.commands.cancel(command.commandId);task.config.costRootTaskId=command.commandId;f.db.query('UPDATE multi_tasks SET config_json=? WHERE id=?').run(JSON.stringify(task.config),task.id);
 const next=await f.coordinator.create({sessionId:room.id,prompt:'Later controlled adaptive child',config:{...task.config,clientRequestId:'later-planning'}});f.db.query('UPDATE room_commands SET task_id=? WHERE id=?').run(next.id,command.commandId);
 return c.json({roomId:room.id,commandId:command.commandId,turnId:turn.id});
});
f.app.get('/__multica/counts', c => c.json({ native: f.nativeCalls.length, gateway: f.gatewayCalls.length, runs: f.db.query('SELECT count(*) AS n FROM agent_runs').get(), commands: f.db.query('SELECT count(*) AS n FROM room_commands').get() }));
const metadataPath = process.env.SOCRATES_MULTICA_METADATA ?? '/private/tmp/socrates-multica-m04-m05.json';
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: f.app.fetch });
writeFileSync(metadataPath, JSON.stringify({ source: 'synthetic-multica-m04-m05', pid: process.pid, port: server.port, token: f.token, roomIds: f.roomIds, workspaceId: f.workspace.id, squadId: squad.id, itemId: item.id }));
console.log('M04–M05 synthetic fixture ready');
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { if (closing) return; closing = true; server.stop(true); void f.close().finally(() => { try { unlinkSync(metadataPath); } catch {} process.exit(0); }); });
