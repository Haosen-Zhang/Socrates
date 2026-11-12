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
