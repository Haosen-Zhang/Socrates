import { expect,test } from "bun:test";
import {writeFileSync} from "node:fs";
import {join} from "node:path";
import { setupCostFlowFixture,untilCostFlow } from "./cost-flow-fixture";

test("a Custom team with one frozen Manager/executor remains a valid reviewed workflow after room defaults change",async()=>{
  const f=await setupCostFlowFixture({routingFixture:true});
  try{
    const room=f.sessions.get(f.roomIds.work)!;
    f.sessions.updateCollaboration(room.id,{...room.collaboration,strategy:"team",assignment:{...room.collaboration.assignment,coordinatorAgentId:"fixture-a",routing:{...room.collaboration.assignment.routing,mode:"manual"}}});
    const input={roomId:room.id,content:"Deliver the controlled result with the explicitly locked team",intent:"execute" as const,mentions:[{type:"agent" as const,agentId:"fixture-a"}]};
    const quote=f.quotes.quote(input);
    expect(quote.route?.selected).toMatchObject({workflow:"team",resolved:{kind:"team",agentIds:["fixture-a"]}});
    const root=await f.commands.submit({...input,quoteId:quote.id,clientRequestId:crypto.randomUUID()});
    await untilCostFlow(()=>f.adaptive.get(root.commandId)?.status==="awaiting_plan","one-member frozen team plan");
    const child=f.adaptive.get(root.commandId)!.attempts[0]!.child!,plan=f.tasks.getPlan(child.id)!;
    expect(f.tasks.get(child.id)?.config.speakingOrder).toEqual(["fixture-a"]);
    expect(f.gatewayCalls.map(call=>[call.purpose,call.agentId])).toEqual([["plan","fixture-a"]]);
    // Route policy may change while a user examines a plan; the frozen child
    // remains authorized, and future child creation does not depend on mode.
    const current=f.sessions.get(room.id)!;
    f.sessions.updateCollaboration(room.id,{...current.collaboration,strategy:"single"});
    // Legacy mode is stable across policy edits; imported/fresh single-mode
    // Work rooms must also execute an authorized frozen team child.
    f.db.query("UPDATE sessions SET mode='single_agent' WHERE id=?").run(room.id);
    expect(f.sessions.get(room.id)?.mode).toBe("single_agent");
    const existing=f.tasks.get(child.id)!;
    expect((await f.tasks.create({sessionId:room.id,prompt:existing.prompt,config:{...existing.config,clientRequestId:"same-frozen-route-another-child"}})).config.routeDecisionId).toBe(quote.route?.selected?f.routes.get(root.commandId)!.id:undefined);
    const response=await f.app.request(`/multi/tasks/${child.id}/plan-decisions`,{method:"POST",headers:f.headers,body:JSON.stringify({version:plan.version,hash:plan.contentHash,decision:"approve_exact_plan",clientDecisionKey:crypto.randomUUID()})});
    expect(response.status).toBe(200);
    await untilCostFlow(()=>f.adaptive.get(root.commandId)?.status==="completed","one-member frozen team completion");
    expect(f.nativeCalls.length).toBeGreaterThan(0);
    expect(f.broker.ledger.list({rootTaskId:root.commandId}).every(call=>call.agentId==="fixture-a")).toBe(true);
  }finally{await f.close();}
});

test("the public legacy task endpoint cannot forge frozen route identity, profiles or cost attribution",async()=>{
  const f=await setupCostFlowFixture();
  try{
    for(const key of ["routeDecisionId","adaptiveAttemptId","allowedAgentIds","routingReviewerId","frozenCollaboration","costRootTaskId"]){
      const response=await f.app.request(`/multi/sessions/${f.roomIds.work}/tasks`,{method:"POST",headers:f.headers,body:JSON.stringify({prompt:"unauthorized internal config",config:{speakingOrder:["fixture-a","fixture-b"],maxRounds:1,synthesizerId:"fixture-a",executionAgentId:"fixture-a",[key]:"forged"}})});
      expect(response.status).toBe(400);expect(await response.json()).toEqual({error:"multi_task_internal_routing_config"});
    }
    expect(f.tasks.list(f.roomIds.work)).toHaveLength(0);expect(f.gatewayCalls).toHaveLength(0);expect(f.nativeCalls).toHaveLength(0);
  }finally{await f.close();}
});

test("legacy Native start/continue endpoints cannot bypass a routed parent's budget and attempt identity",async()=>{
  const f=await setupCostFlowFixture({routingFixture:true});
  try{
    const room=f.sessions.get(f.roomIds.work)!;
    writeFileSync(join(f.workspace.canonicalPath,"context.txt"),"Synthetic tool result. ".repeat(1600));
    f.sessions.updateCollaboration(room.id,{...room.collaboration,strategy:"adaptive",assignment:{...room.collaboration.assignment,routing:{...room.collaboration.assignment.routing,automaticPolicy:"cost",limits:{maxRetries:0,maxEscalations:0,maxTotalModelCalls:24}}}});
    const base={roomId:room.id,content:"Preserve the routed controlled write",intent:"execute" as const,mentions:[],maxOutputTokens:256};
    const preview=f.quotes.quote(base),input={...base,budget:{mode:"soft_limit" as const,limitAtomic:preview.highAtomic!}},quote=f.quotes.quote(input);
    const root=await f.commands.submit({...input,quoteId:quote.id,clientRequestId:crypto.randomUUID()});
    await untilCostFlow(()=>f.adaptive.get(root.commandId)?.status==="paused_budget","root paused after writing");
    const attempt=f.adaptive.get(root.commandId)!.attempts[0]!,count=f.nativeCalls.length;
    const runs=f.db.query("SELECT count(*) AS n FROM agent_runs").get();
    const continued=await f.app.request(`/agent/runs/${attempt.child!.id}/continue`,{method:"POST",headers:f.headers});
    expect(continued.status).toBe(409);expect(await continued.json()).toEqual({error:"adaptive_recovery_required"});
    const replay=await f.app.request(`/agent/sessions/${room.id}/runs`,{method:"POST",headers:f.headers,body:JSON.stringify({prompt:base.content,clientTurnKey:attempt.clientTurnKey,runtimeOptions:{costRootTaskId:root.commandId,costRouteAttemptId:attempt.id}})});
    expect(replay.status).toBe(409);expect(await replay.json()).toEqual({error:"adaptive_recovery_required"});
    expect(f.nativeCalls).toHaveLength(count);expect(f.db.query("SELECT count(*) AS n FROM agent_runs").get()).toEqual(runs);
    expect(f.adaptive.get(root.commandId)?.status).toBe("paused_budget");
    expect(f.db.query("SELECT count(*) AS n FROM tool_calls WHERE name='write_file'").get()).toEqual({n:1});
  }finally{await f.close();}
});
