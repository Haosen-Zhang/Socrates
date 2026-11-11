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
