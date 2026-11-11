import { writeFileSync, unlinkSync } from 'node:fs';
import { setupCostFlowFixture, untilCostFlow } from '../apps/sidecar/src/services/cost-flow-fixture';

// Only synthetic data and the controlled local provider; no real user store is opened.
const f = await setupCostFlowFixture({ routingFixture: true, nativeToolCalls: () => [] });
f.sessions.rename(f.roomIds.work, 'Lifecycle acceptance lab');
const squad = f.squads.create({ workspaceId: f.workspace.id, name: 'Lifecycle squad', avatar: 'robot', leaderAgentId: 'fixture-a', description: 'Synthetic lifecycle verification', instructions: 'Use approved work packages.', members: [{ agentId: 'fixture-a', responsibility: 'Build' }, { agentId: 'fixture-b', responsibility: 'Review' }] });
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
f.app.get('/__multica/counts', c => c.json({ native: f.nativeCalls.length, gateway: f.gatewayCalls.length, runs: f.db.query('SELECT count(*) AS n FROM agent_runs').get(), commands: f.db.query('SELECT count(*) AS n FROM room_commands').get() }));
const metadataPath = process.env.SOCRATES_MULTICA_METADATA ?? '/private/tmp/socrates-multica-m04-m05.json';
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: f.app.fetch });
writeFileSync(metadataPath, JSON.stringify({ source: 'synthetic-multica-m04-m05', pid: process.pid, port: server.port, token: f.token, roomIds: f.roomIds, workspaceId: f.workspace.id, squadId: squad.id, itemId: item.id }));
console.log('M04–M05 synthetic fixture ready');
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { if (closing) return; closing = true; server.stop(true); void f.close().finally(() => { try { unlinkSync(metadataPath); } catch {} process.exit(0); }); });
