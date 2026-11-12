import { test, expect } from 'bun:test';
import { openDb } from '../db';
import { WorkItemService } from './work-items';
test('assignment is durable and creates no execution; review requires completed root',()=>{
 const db=openDb(':memory:');
 db.exec("INSERT INTO workspaces(id,canonical_path,display_path,identity_hash,label,created_at,last_opened_at) VALUES('w','/tmp/w','/tmp/w','w','w','now','now'); INSERT INTO providers(id,name,type,base_url,api_key_ref,created_at,updated_at) VALUES('p','p','openai','https://example.test','ref','now','now'); INSERT INTO agents(id,display_name,provider_id,model_id,created_at,updated_at) VALUES('a','a','p','m','now','now')");
 const service=new WorkItemService(db,{get:()=>null});
 const item=service.create({workspaceId:'w',title:'Task',objective:'Goal',acceptanceCriteria:['Pass'],ownerKind:'user',priority:'normal'});
 expect(item.workflow).toBe('backlog');
 const assigned=service.assign(item.id,1,{ownerKind:'agent',ownerId:'a',runDisposition:'keep_current'});
 expect(assigned.workflow).toBe('todo'); expect(assigned.runs).toHaveLength(0);
 expect(db.query('SELECT id FROM work_item_runs').all()).toHaveLength(0);
 expect(()=>service.assign(item.id,1,{ownerKind:'user',runDisposition:'keep_current'})).toThrow('changed');
 expect(()=>service.review(item.id,2,'accept')).toThrow('not awaiting review');
 expect(service.list('w')[0]?.ownerId).toBe('a'); db.close();
});

test('list retains authoritative review and run state without loading detail history',async()=>{
 const {setupCostFlowFixture,untilCostFlow}=await import('./cost-flow-fixture');
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});
 try {
  const item=f.workItems.create({workspaceId:f.workspace.id,title:'History',objective:'Read lazily',acceptanceCriteria:[],ownerKind:'agent',ownerId:'fixture-a',priority:'normal'});
  const preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'agent',ownerId:'fixture-a'});
  await f.workItemLaunch.start(item.id,{previewId:preview.id,expectedRevision:item.revision,clientRequestId:'summary-test'});
  await untilCostFlow(()=>f.workItems.get(item.id)?.workflow==='in_review','summary completion');
  const summary=f.workItems.list(f.workspace.id)[0]!;
  expect(summary.workflow).toBe('in_review');expect(summary.currentRun?.commandStatus).toBe('completed');
  expect('messages' in summary).toBe(false);expect('reviews' in summary).toBe(false);expect('workPackages' in summary).toBe(false);expect('artifacts' in summary).toBe(false);
  const detail=f.workItems.get(item.id)!;
  expect(detail.messages.length).toBeGreaterThan(0);
  const {messages,workPackages,reviews,artifacts,...expected}=detail;
  expect(summary).toEqual(expected);
  f.workItems.review(item.id,detail.revision,'accept');
  expect(f.workItems.list(f.workspace.id)[0]!.workflow).toBe('done');
  expect(f.workItems.get(item.id)?.reviews).toHaveLength(1);
 }finally{await f.close();}
});

for(const unavailable of ['room_archive','workspace_archive','missing_directory'] as const)test(`verified history stays readable and fails closed after ${unavailable}`,async()=>{
 const {setupCostFlowFixture,untilCostFlow}=await import('./cost-flow-fixture');
 const {renameSync}=await import('node:fs');
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});let moved=false;
 try {
  const squad=f.squads.create({workspaceId:f.workspace.id,name:'History squad',avatar:null,description:'',instructions:'',leaderAgentId:'fixture-a',members:[{agentId:'fixture-a',responsibility:'Lead'}]});
  const make=(title:string)=>f.workItems.create({workspaceId:f.workspace.id,title,objective:'Inspect context.txt',acceptanceCriteria:[],ownerKind:'agent',ownerId:'fixture-a',priority:'normal'});
  const item=make('Verified history'),unrelated=make('Unrelated review');
  const preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'agent',ownerId:'fixture-a'});
  const plan=f.verification.prepare({roomId:preview.executionRoomId,requestId:'plan',checks:[{id:'file',label:'Context',kind:'file',path:'context.txt',required:true,origin:'user'}],artifactPaths:['context.txt'],protectedPaths:[]});
  f.verification.approve(plan.id,'approve');const bound=f.workItemLaunch.requote(item.id,preview.id,plan.id);
  await f.workItemLaunch.start(item.id,{previewId:bound.id,expectedRevision:item.revision,clientRequestId:'verified'});
  await untilCostFlow(()=>f.workItems.get(item.id)?.workflow==='in_review','verified completion');
  const other=f.workItemLaunch.preview(unrelated.id,{expectedRevision:unrelated.revision,ownerKind:'agent',ownerId:'fixture-a'});
  await f.workItemLaunch.start(unrelated.id,{previewId:other.id,expectedRevision:unrelated.revision,clientRequestId:'unrelated'});
  await untilCostFlow(()=>f.workItems.get(unrelated.id)?.workflow==='in_review','unrelated completion');
  const accepted=f.workItems.review(item.id,f.workItems.get(item.id)!.revision,'accept');expect(accepted.workflow).toBe('done');
  const target={roomId:preview.executionRoomId,rootTaskId:accepted.currentRun!.commandId!},evidence=f.verification.view(target),calls=f.nativeCalls.length;
  const stored=f.db.query('SELECT * FROM verification_runs WHERE plan_id=?').all(evidence.plan!.id);
  if(unavailable==='room_archive')f.sessions.archive(preview.executionRoomId,true);
  else if(unavailable==='workspace_archive')f.workspaces.archive(f.workspace.id,true);
  else {renameSync(f.workspace.canonicalPath,f.workspace.canonicalPath+'-moved');moved=true;}
  const changed=f.workItems.get(item.id)!;
  expect(changed).toMatchObject({workflow:'in_review',reviewState:'pending',waitReason:'verification_invalidated'});
  expect(changed.messages).toEqual(accepted.messages);expect(changed.reviews).toEqual(accepted.reviews);expect(changed.runs).toEqual(accepted.runs);
  expect(f.workItems.list(f.workspace.id)).toEqual(expect.arrayContaining([expect.objectContaining({id:item.id,workflow:'in_review'}),expect.objectContaining({id:unrelated.id,workflow:'in_review'})]));
  for(const path of [`/work-items?workspaceId=${f.workspace.id}`,`/work-items/${item.id}`,`/squads?workspaceId=${f.workspace.id}`,`/squads/${squad.id}`])expect((await f.app.request(path,{headers:f.headers})).status).toBe(200);
  const inbox=f.inbox.list();expect(inbox.items.some(i=>i.link.workItemId===unrelated.id)).toBe(true);expect(inbox.items.some(i=>i.kind==='verification'&&i.link.workItemId===item.id)).toBe(true);
  const view=f.verification.view(target);expect(view).toMatchObject({gatePassed:false,acceptedUnverified:false,verificationStatus:'invalidated',outcome:'completed_unverified'});expect(view.plan?.id).toBe(evidence.plan?.id);expect(view.run?.id).toBe(evidence.run?.id);
  expect(()=>f.workItems.review(item.id,changed.revision,'accept')).toThrow('verification_required_before_acceptance');
  expect(()=>f.verification.acceptUnverified(target,'unavailable-accept')).toThrow();
  await expect(f.verification.verify(target,{requestId:evidence.run!.requestId})).rejects.toThrow();
  expect(f.db.query('SELECT * FROM verification_runs WHERE plan_id=?').all(evidence.plan!.id)).toEqual(stored);
  expect(f.workItems.get(item.id)!.reviews).toEqual(accepted.reviews);expect(f.nativeCalls).toHaveLength(calls);expect(f.gatewayCalls).toHaveLength(0);
 }finally{if(moved)renameSync(f.workspace.canonicalPath+'-moved',f.workspace.canonicalPath);await f.close();}
});

test('verification read projection preserves pending history and propagates unrelated service errors',async()=>{
 const {setupCostFlowFixture}=await import('./cost-flow-fixture');const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});
 const original=f.sessions.get.bind(f.sessions);
 try {
  const plan=f.verification.prepare({roomId:f.roomIds.work,requestId:'pending',checks:[{id:'file',label:'Context',kind:'file',path:'context.txt',required:true,origin:'user'}],artifactPaths:['context.txt'],protectedPaths:[]});
  f.verification.acceptUnverified(plan.target,'prior-acceptance');
  f.sessions.archive(f.roomIds.work,true);
  expect(()=>f.verification.acceptUnverified(plan.target,'prior-acceptance')).toThrow('verification_room_unavailable');
  expect(f.verification.view(plan.target)).toMatchObject({plan,run:null,verificationStatus:'invalidated',acceptedUnverified:false,gatePassed:false});
  f.sessions.get=()=>{throw new Error('unexpected_store_failure');};
  expect(()=>f.verification.view(plan.target)).toThrow('unexpected_store_failure');
  expect(f.nativeCalls).toHaveLength(0);expect(f.gatewayCalls).toHaveLength(0);
 }finally{f.sessions.get=original;await f.close();}
});
