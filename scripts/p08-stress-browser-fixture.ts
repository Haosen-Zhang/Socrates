import {writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {setupCostFlowFixture} from '../apps/sidecar/src/services/cost-flow-fixture';
const f=await setupCostFlowFixture({routingFixture:true});
const room=f.sessions.get(f.roomIds.work)!;f.sessions.rename(room.id,'Stress Work');
f.sessions.updateCollaboration(room.id,{...room.collaboration,strategy:'single'});
writeFileSync(join(f.workspace.canonicalPath,'package.json'),JSON.stringify({name:'synthetic-stress',scripts:{test:'bun test acceptance.test.ts'}}));
writeFileSync(join(f.workspace.canonicalPath,'acceptance.test.ts'),"import {test,expect} from 'bun:test';\nconsole.log('LONG_LOG_START\\n'+Array.from({length:2000},(_,i)=>'Synthetic diagnostic '+i+' '+ 'x'.repeat(160)).join('\\n')+'\\nLONG_LOG_END');test('stress invariant',()=>expect(1).toBe(1));\n");
f.app.get('/__p08/counts',c=>c.json({native:f.nativeCalls.length,gateway:f.gatewayCalls.length}));
f.app.post('/__p08/seed-money',c=>{
 for(const [i,currency] of ['USD','CNY',null].entries()){
 const price=currency?f.broker.prices.save({providerConnectionId:'fixture-provider',modelId:`stress-${i}`,protocol:'openai_chat_completions',baseUrl:'https://fixture.invalid/v1',currency,rates:{input:'0.000001',output:'0.000001'},source:'user_confirmed',sourceVersion:'synthetic-stress',usageSemantics:{inputIncludesCacheRead:true,inputIncludesCacheWrite:true,outputIncludesReasoning:true}}):null;
 const id=`stress-ledger-${i}`;f.broker.ledger.begin({invocationId:id,logicalStepId:id,attemptNo:1,roomId:room.id,rootTaskId:'stress-money',runId:'stress-money',agentId:'fixture-a',purpose:'respond',providerConnectionId:'fixture-provider',modelId:`stress-${i}`,runProfileVersion:'fixture-v1',traceId:'stress',spanId:`stress-${i}`},price?.id??null);f.broker.ledger.markSent(id);if(currency)f.broker.ledger.finish(id,{usage:{inputTokens:1,outputTokens:0}});else f.broker.ledger.markUnknown(id);
 }return c.json({controlledFixture:true});
});
const metadataPath='/private/tmp/socrates-p08-stress.json';
const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,fetch:f.app.fetch});
writeFileSync(metadataPath,JSON.stringify({source:'synthetic-p08-stress',port:server.port,token:f.token,roomIds:f.roomIds}));
console.log('P08 synthetic stress fixture ready');let closing=false;
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{if(closing)return;closing=true;server.stop(true);void f.close().finally(()=>{try{unlinkSync(metadataPath);}catch{}process.exit(0);});});
