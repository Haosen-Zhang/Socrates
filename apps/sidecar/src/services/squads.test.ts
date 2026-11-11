import {test,expect} from 'bun:test';
import {DEFAULT_COLLABORATION_SETTINGS} from '@socrates/core';
import {openDb} from '../db';
import {SquadService} from './squads';
test('Squad revisions, frozen room application and archival preserve history',()=>{
 const db=openDb(':memory:');
 db.exec("INSERT INTO workspaces(id,canonical_path,display_path,identity_hash,label,created_at,last_opened_at) VALUES('w','/tmp/w','/tmp/w','w','w','now','now'); INSERT INTO providers(id,name,type,base_url,api_key_ref,created_at,updated_at) VALUES('p','p','openai','https://example.test','ref','now','now')");
 for(const id of ['a','b']) db.query('INSERT INTO agents(id,display_name,provider_id,model_id,model_capabilities_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,id,'p','model',JSON.stringify({toolCalling:true}),'now','now');
 const service=new SquadService(db);
 const input={workspaceId:'w',name:'Team',avatar:null,description:'Test',instructions:'Leader only',leaderAgentId:'a',members:[{agentId:'a',responsibility:'Lead'},{agentId:'b',responsibility:'Review'}]};
 const first=service.create(input);
 expect(()=>service.create(input)).toThrow();
 expect(()=>service.update(first.id,1,{...input,members:[input.members[1]!]})).toThrow('Leader');
 const a=service.createRoom(first.id,1,'A'), b=service.createRoom(first.id,1,'B');
 expect(a.room.collaboration.discussion.enabled).toBe(false);
 expect(a.room.agents.find(m=>m.agentId==='b')?.snapshot.systemPrompt).not.toContain('Leader only');
 service.update(first.id,1,{...input,description:'Changed',leaderAgentId:'b'});
 expect(()=>service.update(first.id,1,input)).toThrow('changed');
 expect(service.binding(a.room.id)?.snapshot.leaderAgentId).toBe('a');
 service.bind(first.id,2,b.room.id,1);
 expect(service.sessions.get(b.room.id)?.primaryAgentId).toBe('b');
 expect(()=>service.bind(first.id,2,b.room.id,1)).toThrow('binding changed');
 expect(service.references(first.id)).toHaveLength(2);
 const other=service.create({...input,name:'Other'});
 service.bind(other.id,1,b.room.id,2);
 expect(service.binding(b.room.id)?.bindingVersion).toBe(3);
 expect(()=>service.bind(first.id,2,b.room.id,2)).toThrow('binding changed');
 for(const mutation of [()=>service.sessions.updatePrimaryAgent(b.room.id,'a'),()=>service.sessions.removeAgent(b.room.id,'b'),()=>service.sessions.updateAgentSnapshot(b.room.id,'a',{}),()=>service.sessions.bindWorkspace(b.room.id,'w'),()=>service.sessions.updateCollaboration(b.room.id,b.room.collaboration)])expect(mutation).toThrow('detach_required');
 service.detach(b.room.id,3);
 service.sessions.updatePrimaryAgent(b.room.id,'a');
 service.bind(first.id,2,b.room.id,null);
 expect(service.binding(b.room.id)?.bindingVersion).toBe(4);
 expect(service.detail(first.id)?.members[0]?.activeRuns).toBe(0);
 service.archive(first.id,2);
 expect(()=>service.createRoom(first.id,3,'No')).toThrow('archived');
 expect(service.binding(a.room.id)?.snapshot.leaderAgentId).toBe('a');
 db.close();
});

test('room creation rolls back together with binding callback',()=>{
 const db=openDb(':memory:');
 db.exec("INSERT INTO workspaces(id,canonical_path,display_path,identity_hash,label,created_at,last_opened_at) VALUES('w','/tmp/w','/tmp/w','w','w','now','now')");
 const service=new SquadService(db);
 expect(()=>service.sessions.create({id:'rollback',title:'Rollback',kind:'cowork',mode:'single_agent',workspaceId:'w',primaryAgentId:'a',agents:[{agentId:'a',snapshot:{},executionEligible:true}]},()=>{throw new Error('binding failure');})).toThrow('binding failure');
 expect(service.sessions.get('rollback')).toBeNull();db.close();
});

test('Squad routes reject malformed payloads without mutation',async()=>{
 const {squadRoutes}=await import('../routes/squads');
 const db=openDb(':memory:');const app=squadRoutes(new SquadService(db));
 for(const body of [{},{name:'bad',members:[]},null]){
   const response=await app.request('/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
   expect(response.status).toBe(400);
 }
 expect(db.query('SELECT id FROM squad_templates').all()).toHaveLength(0);db.close();
});

test('multiple providers and responsibilities survive reopen; public API conflicts are atomic',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {squadRoutes}=await import('../routes/squads');
 const directory=mkdtempSync(join(tmpdir(),'squad-reopen-'));const path=join(directory,'test.db');
 try {
 let db=openDb(path);
 db.exec("INSERT INTO workspaces(id,canonical_path,display_path,identity_hash,label,created_at,last_opened_at) VALUES('w','/tmp/w','/tmp/w','w','w','now','now')");
 const members=['anthropic','openai','deepseek'].map((provider,i)=>{
  db.query('INSERT INTO providers(id,name,type,base_url,api_key_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(provider,provider,provider==='anthropic'?'anthropic':'openai','https://example.test','fixture','now','now');
  db.query('INSERT INTO agents(id,display_name,provider_id,model_id,model_capabilities_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('a'+i,'A'+i,provider,'model',JSON.stringify({toolCalling:true}),'now','now');return {agentId:'a'+i,responsibility:'Role '+i};
 });
 const input={workspaceId:'w',name:'Persistent',avatar:null,leaderAgentId:'a0',description:'Three providers',instructions:'Lead',members};
 const squad=new SquadService(db).create(input);db.close();db=openDb(path);
 const service=new SquadService(db);expect(service.get(squad.id)?.members).toEqual(members);
 const app=squadRoutes(service);const request=(url:string,body:unknown)=>app.request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const response=await request('/'+squad.id+'/rooms',{title:'Persistent',expectedRevision:1});expect(response.status).toBe(201);
 const result=await response.json() as {room:{id:string}};
 expect((await request('/'+squad.id+'/bind',{roomId:result.room.id,expectedRevision:1,expectedBindingVersion:0})).status).toBe(409);
 expect((await request('/rooms/'+result.room.id+'/detach',{expectedBindingVersion:1})).status).toBe(200);
 expect(service.binding(result.room.id)).toBeNull();db.close();
 }finally{rmSync(directory,{recursive:true,force:true});}
});


test('explicit singleton team remains team while partially eligible roster downgrades',()=>{
 const db=openDb(':memory:');
 db.exec("INSERT INTO workspaces(id,canonical_path,display_path,identity_hash,label,created_at,last_opened_at) VALUES('w','/tmp/w','/tmp/w','w','w','now','now')");
 const service=new SquadService(db);
 const base={title:'Team',kind:'cowork' as const,mode:'single_agent' as const,workspaceId:'w',primaryAgentId:'a',collaborationDefaults:{...DEFAULT_COLLABORATION_SETTINGS,strategy:'team' as const},agents:[{agentId:'a',snapshot:{},executionEligible:true}]};
 expect(service.sessions.create(base).collaboration.strategy).toBe('team');
 expect(service.sessions.create({...base,mode:'multi_agent',agents:[...base.agents,{agentId:'b',snapshot:{},executionEligible:false}]}).collaboration.strategy).toBe('single');
 db.close();
});
