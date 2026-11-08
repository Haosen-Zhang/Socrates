import {test,expect} from 'bun:test';
import {openDb} from '../db';
import {arenaToolBoundary} from './arena-boundary';
test('Arena blocks external tools and protected parent mutations even after approval',()=>{
 const db=openDb(':memory:');
 db.query('INSERT INTO arena_experiments VALUES(?,?,?,?,?,?)').run('e','source','key','hash',JSON.stringify({definition:{tasks:[{id:'task',protectedPaths:['tests/frozen.ts']}]}}),'{}');
 db.query('INSERT INTO arena_trials VALUES(?,?,?,?)').run('trial','e','room',JSON.stringify({taskId:'task'}));
 expect(arenaToolBoundary(db,'room','mcp',{}).denial).toBe('arena_external_tool_denied');
 expect(arenaToolBoundary(db,'room','workspace_write',{source:'tests',destination:'old'}).denial).toBe('arena_protected_definition');
 expect(arenaToolBoundary(db,'room','workspace_write',{path:'src/a.ts'}).denial).toBeUndefined();
 expect(arenaToolBoundary(db,'room','shell',{}).protectedPaths).toEqual(['tests/frozen.ts']);
 expect(arenaToolBoundary(db,'ordinary','mcp',{}).denial).toBeUndefined();db.close();
});

import type {ToolCapability,ToolContext,ToolDefinition} from '@socrates/core';
import {ToolExecutor} from './executor';
import {ToolRegistry} from './registry';
import {ApprovalManager} from '../approvals/manager';
for(const capability of ['mcp','workspace_write'] as ToolCapability[])test(`actual ToolExecutor rechecks Arena ${capability} boundary after durable approval`,async()=>{
 const db=openDb(':memory:');let calls=0;const approvals=new ApprovalManager(db);
 const tool:ToolDefinition={name:'controlled',generation:1,description:'fixture',capability,risk:'low',idempotency:'read',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path']},async execute(){calls++;return 'executed';}};
 const executor=new ToolExecutor(db,new ToolRegistry([tool]),approvals);
 const context:ToolContext={callId:'approved-call',sessionId:'room',taskId:'task',turnId:'turn',agentId:'a',workspaceId:'w',mode:'single_agent',phase:'executing',signal:new AbortController().signal};
 const pending=await executor.invoke({stableKey:'approved-call',name:'controlled',generation:1,input:{path:'tests/frozen.ts'},workspaceIdentity:'w',policyVersion:1},context,{effect:'ask',risk:'low',matchedRuleIds:[],reasonCode:'test',freshHumanRequired:false,policyVersion:1});
 expect(pending.status).toBe('awaiting_approval');approvals.decide(pending.approval!.id,{clientDecisionKey:'allow',decision:'allow_once'});
 db.query('INSERT INTO arena_experiments VALUES(?,?,?,?,?,?)').run('e','source','key','hash',JSON.stringify({definition:{tasks:[{id:'task',protectedPaths:['tests/frozen.ts']}]}}),'{}');
 db.query('INSERT INTO arena_trials VALUES(?,?,?,?)').run('trial','e','room',JSON.stringify({taskId:'task'}));
 const result=await executor.resumeApproved(pending.id,context);expect(result.status).toBe('failed');expect(result.error).toContain('arena_');expect(calls).toBe(0);db.close();
});
