import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupCostFlowFixture, untilCostFlow } from './cost-flow-fixture';

test('automatic admission switch rejects only new roots while quotes, duplicate lookup and frozen budget resume survive',async()=>{
 const f=await setupCostFlowFixture({routingFixture:true});
 const previous=process.env.SOCRATES_AUTOMATIC_ADMISSION_ENABLED;
 try {
  const room=f.sessions.get(f.roomIds.work)!;
  f.sessions.updateCollaboration(room.id,{...room.collaboration,strategy:'adaptive',assignment:{...room.collaboration.assignment,routing:{...room.collaboration.assignment.routing,automaticPolicy:'cost',limits:{maxRetries:0,maxEscalations:0,maxTotalModelCalls:24}}}});
  writeFileSync(join(f.workspace.canonicalPath,'context.txt'),'Synthetic tool result. '.repeat(1600));
  const base={roomId:room.id,content:'Complete controlled fixture',intent:'execute' as const,mentions:[],maxOutputTokens:256};
  const input={...base,budget:{mode:'soft_limit' as const,limitAtomic:f.quotes.quote(base).highAtomic!}};
  const quote=f.quotes.quote(input);
  const submitted={...input,quoteId:quote.id,clientRequestId:'existing-before-disable'};
  const command=await f.commands.submit(submitted);
  await untilCostFlow(()=>f.adaptive.get(command.commandId)?.status==='paused_budget','admission_pause');
  const frozen=f.routes.get(command.commandId),beforeCalls=f.nativeCalls.length;
  process.env.SOCRATES_AUTOMATIC_ADMISSION_ENABLED='false';
  expect((await f.commands.submit(submitted)).commandId).toBe(command.commandId);
  expect(f.quotes.quote(input).id).toBeTruthy();
  await expect(f.commands.submit({...input,clientRequestId:'new-disabled'})).rejects.toThrow('automatic_new_task_admission_disabled');
  expect(f.nativeCalls.length).toBe(beforeCalls);
  expect(f.db.query("SELECT count(*) n FROM room_commands WHERE client_request_id='new-disabled'").get()).toEqual({n:0});
  f.broker.budgets.increase(command.commandId,{requestId:'topup',expectedRevision:1,amountAtomic:'1000000000000'});
  await f.costTasks.resume(command.commandId,{requestId:'resume-existing'});
  await untilCostFlow(()=>f.adaptive.get(command.commandId)?.status==='completed','admission_resume');
  expect(f.routes.get(command.commandId)).toEqual(frozen);
  expect(f.broker.ledger.list({rootTaskId:command.commandId}).length).toBeGreaterThan(0);
 }finally{if(previous===undefined)delete process.env.SOCRATES_AUTOMATIC_ADMISSION_ENABLED;else process.env.SOCRATES_AUTOMATIC_ADMISSION_ENABLED=previous;await f.close();}
},20000);
