import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelGateway, OrchestrationAgent, RouteWorkflow } from "@socrates/core";
import { setupCostFlowFixture, untilCostFlow } from "./cost-flow-fixture";
import { MultiAgentCoordinator } from "../multi-agent/coordinator";
import { EventStore } from "../store/event-store";
import { createAdaptiveHosts } from "./adaptive-hosts";

type Fixture = Awaited<ReturnType<typeof setupCostFlowFixture>>;
function configure(f: Fixture) {
  writeFileSync(join(f.workspace.canonicalPath, "security.md"), "Synthetic security acceptance fixture.");
  for(const name of ["module-a","module-b"]){
    mkdirSync(join(f.workspace.canonicalPath,name));
    writeFileSync(join(f.workspace.canonicalPath,name,"package.json"),JSON.stringify({name}));
    writeFileSync(join(f.workspace.canonicalPath,name,"readme.md"),`Synthetic ${name}`);
  }
  const room = f.sessions.get(f.roomIds.work)!;
  f.sessions.updateCollaboration(room.id, { ...room.collaboration, strategy: "adaptive", assignment: { ...room.collaboration.assignment,
    callableAgentIds: ["fixture-a", "fixture-b", "fixture-c"], routing: { ...room.collaboration.assignment.routing, automaticPolicy: "quality", fallbackAgentIds: ["fixture-c"] } } });
}
function acceptance(f: Fixture, answer: string) {
  const draft = f.verification.prepare({ roomId: f.roomIds.work, requestId: crypto.randomUUID(), artifactPaths: ["result.txt"], protectedPaths: [], checks: [
    { id: "expected-result", kind: "file", label: "Expected result", required: true, origin: "user", path: "result.txt", contains: answer },
  ] });
  return f.verification.approve(draft.id, crypto.randomUUID());
}
async function submit(f: Fixture, workflow: RouteWorkflow, planId?: string) {
  const input = { roomId: f.roomIds.work, content: "Complete the controlled delivery for security.md"+(["plan_execute","team"].includes(workflow)?" with module-a/readme.md and module-b/readme.md":""), intent: "execute" as const, mentions: [], ...(planId ? { verificationPlanId: planId } : {}) };
  const preview = f.routes.preview(input);
  const candidate = preview.candidates.find(item => item.workflow === workflow && item.feasible && !item.fallbackOnly)!;
  expect(candidate).toBeDefined();
  const requested = { ...input, routingCandidateId: candidate.id }, quote = f.quotes.quote(requested);
  return f.commands.submit({ ...requested, quoteId: quote.id, clientRequestId: crypto.randomUUID() });
}
async function approve(f: Fixture, rootTaskId: string) {
  await untilCostFlow(() => {
    const view=f.adaptive.get(rootTaskId);
    if(view&&["blocked","failed","interrupted"].includes(view.status))throw new Error(`unexpected_workflow:${JSON.stringify({status:view.status,reason:view.reason,attempt:view.attempts.at(-1)})}`);
    return view?.status === "awaiting_plan";
  }, "adaptive plan approval");
  const child = f.adaptive.get(rootTaskId)!.attempts.at(-1)!.child!, plan = f.tasks.getPlan(child.id)!;
  const response = await f.app.request(`/multi/tasks/${child.id}/plan-decisions`, { method: "POST", headers: f.headers,
    body: JSON.stringify({ version: plan.version, hash: plan.contentHash, decision: "approve_exact_plan", clientDecisionKey: crypto.randomUUID() }) });
  expect(response.status).toBe(200);
  return child;
}

test("execute_review freezes its materialized package acceptance before approval and actually runs independent review", async () => {
  const f = await setupCostFlowFixture({ routingFixture: true });
  try {
    configure(f);
    const plan = acceptance(f, "Written once"), command = await submit(f, "execute_review", plan.id);
    await untilCostFlow(() => f.adaptive.get(command.commandId)?.status === "awaiting_plan", "static plan ready");
    const first = f.adaptive.get(command.commandId)!.attempts[0]!, item = f.packages.list(first.child!.id)[0]!;
    expect(item).toBeDefined();
    expect(f.verification.view({ roomId: f.roomIds.work, rootTaskId: command.commandId, workPackageId: item.id }).plan?.approvalStatus).toBe("approved");
    expect(f.gatewayCalls).toHaveLength(0);
    await approve(f, command.commandId);
    await untilCostFlow(() => f.adaptive.get(command.commandId)?.status === "completed", "static reviewed completion");
    expect(f.adaptive.get(command.commandId)).toMatchObject({ outcome: "verified_success" });
    expect(f.gatewayCalls.map(call => [call.purpose, call.agentId])).toEqual([["review", first.assignments.reviewerId!]]);
    expect(f.broker.ledger.list({ rootTaskId: command.commandId }).some(call => call.purpose === "review" && call.agentId === first.assignments.reviewerId)).toBe(true);
    expect(f.db.query("SELECT COUNT(*) AS n FROM tool_calls WHERE name='write_file'").get()).toEqual({ n: 1 });
  } finally { await f.close(); }
});

for(const workflow of ["direct","plan_execute","team"] as const)test(`real ${workflow} host preserves frozen roles, records paid stages, and reaches machine acceptance`,async()=>{
  const f=await setupCostFlowFixture({routingFixture:true});
  try{
    configure(f);
    const plan=acceptance(f,"Written once"),command=await submit(f,workflow,plan.id);
    if(workflow!=="direct")await approve(f,command.commandId);
    await untilCostFlow(()=>f.adaptive.get(command.commandId)?.status==="completed",`${workflow} verified completion`);
    const view=f.adaptive.get(command.commandId)!,attempt=view.attempts[0]!;
    expect(view).toMatchObject({workflow,outcome:"verified_success"});
    expect(view.attempts).toHaveLength(1);
    const invocations=f.broker.ledger.list({rootTaskId:command.commandId});
    expect(invocations.length).toBe(view.modelCalls);
    expect(invocations.every(call=>call.state==="finished"&&call.status==="priced")).toBe(true);
    expect(f.gatewayCalls.filter(call=>call.purpose==="plan").map(call=>call.agentId)).toEqual(workflow==="direct"?[]:[attempt.assignments.managerId!]);
    expect(f.gatewayCalls.filter(call=>call.purpose==="review").every(call=>call.agentId===attempt.assignments.reviewerId)).toBe(true);
    const actualExecutors=[...new Set(invocations.filter(call=>call.purpose==="execute").map(call=>call.agentId))].sort();
    expect(actualExecutors).toEqual([...attempt.assignments.executorIds].sort());
    expect(f.db.query("SELECT COUNT(*) AS n FROM tool_calls WHERE name='write_file'").get()).toEqual({n:1});
  }finally{await f.close();}
});

test("Custom honors and bills an explicit speaker outside the execution and manager roles",async()=>{
  const f=await setupCostFlowFixture({routingFixture:true});
  try{
    configure(f);
    const room=f.sessions.get(f.roomIds.work)!;
    f.sessions.updateCollaboration(room.id,{...room.collaboration,strategy:"team",assignment:{...room.collaboration.assignment,routing:{...room.collaboration.assignment.routing,mode:"manual",lightweightAgentId:"fixture-b"}},
      discussion:{...room.collaboration.discussion,enabled:true,maxRounds:1,speakerOrder:["fixture-c"],summaryAgentId:"fixture-a"}});
    const input={roomId:room.id,content:"Complete the controlled delivery",intent:"execute" as const,mentions:[]};
    const quote=f.quotes.quote(input);
    expect(quote.route?.selected?.resolved.agentIds).toEqual(["fixture-b","fixture-a","fixture-c"]);
    expect(quote.route?.selected?.stages.find(stage=>stage.stage==="discussion")?.agentIds).toEqual(["fixture-c"]);
    const command=await f.commands.submit({...input,quoteId:quote.id,clientRequestId:"custom-speaker"});
    const child=await approve(f,command.commandId);
    await untilCostFlow(()=>f.adaptive.get(command.commandId)?.status==="completed","custom discussion completion");
    expect(f.tasks.get(child.id)?.config.frozenCollaboration?.discussion).toMatchObject({speakerOrder:["fixture-c"],summaryAgentId:"fixture-a"});
    expect(f.gatewayCalls.map(call=>[call.purpose,call.agentId])).toEqual([["respond","fixture-c"],["plan","fixture-a"]]);
    expect(f.broker.ledger.list({rootTaskId:command.commandId}).filter(call=>call.purpose==="respond").map(call=>call.agentId)).toEqual(["fixture-c"]);
  }finally{await f.close();}
});

test("real failed package evidence drives bounded repair, retains the original user goal, and stops an unchanged failure", async () => {
  const f = await setupCostFlowFixture({ routingFixture: true });
  try {
    configure(f);
    const plan = acceptance(f, "deliberately absent acceptance"), command = await submit(f, "execute_review", plan.id);
    const firstChild = await approve(f, command.commandId);
    await untilCostFlow(() => f.adaptive.get(command.commandId)!.attempts.length === 2, "bounded repair attempt");
    const repair = f.adaptive.get(command.commandId)!.attempts[1]!;
    expect(repair.handoff?.failureCategory).toBe("verification");
    expect(repair.handoff?.evidenceRefs.length).toBeGreaterThan(0);
    await approve(f, command.commandId);
    await untilCostFlow(() => f.adaptive.get(command.commandId)?.status === "failed", "unchanged failure stop");
    const result = f.adaptive.get(command.commandId)!;
    expect(result.reason).toBe("routing_repeated_failure_without_change");
    expect(result.attempts).toHaveLength(2);
    for (const attempt of result.attempts) expect(f.tasks.get(attempt.child!.id)?.prompt).toBe("Complete the controlled delivery for security.md");
    expect(f.tasks.get(result.attempts[1]!.child!.id)?.config.inputContext).toContain("untrusted");
    expect(f.gatewayCalls).toHaveLength(0);
    expect(f.db.query("SELECT COUNT(*) AS n FROM tool_calls WHERE name='write_file'").get()).toEqual({ n: 1 });
    // The first attempt remains inspectable without controlling the latest gate.
    const oldPackage = f.packages.list(firstChild.id)[0]!;
    const oldTarget={ roomId: f.roomIds.work, rootTaskId: command.commandId, workPackageId: oldPackage.id };
    expect(f.verification.view(oldTarget).run?.status).toBe("failed");
    await expect(f.verification.verify(oldTarget,{requestId:"no-historical-rerun"})).rejects.toThrow("verification_target_retired");
    expect(()=>f.verification.acceptUnverified(oldTarget,"no-historical-acceptance")).toThrow("verification_target_retired");
  } finally { await f.close(); }
});

for(const action of ["cancel","interrupt"] as const)test(`host ${action} waits for actual planning owner and its final durable writes`,async()=>{
  const f=await setupCostFlowFixture({routingFixture:true});
  try{
    let entered=false,settled=false;
    const gateway:ModelGateway=async function*(input){
      yield {type:"delta",text:"partial fixture output"};
      await new Promise<void>(resolve=>{input.signal!.addEventListener("abort",()=>{void Bun.sleep(30).then(()=>{settled=true;resolve();});},{once:true});entered=true;});
      input.signal!.throwIfAborted();
    };
    const resolveAgent=(id:string):OrchestrationAgent=>({id,nickname:id,modelId:"controlled",role:"",systemPrompt:"",providerType:"openai_compatible",baseUrl:"https://fixture.invalid",apiKey:"fixture"});
    const coordinator=new MultiAgentCoordinator(f.db,f.tasks,new EventStore(f.db),gateway,resolveAgent);
    const hosts=createAdaptiveHosts(f.db,f.routes,f.sessions,f.supervisor,f.runner,f.tasks,coordinator,f.team,f.verification);
    const task=await coordinator.create({sessionId:f.roomIds.work,prompt:"Controlled cancellable planning",config:{speakingOrder:["fixture-a","fixture-b"],maxRounds:1,synthesizerId:"fixture-a",executionAgentId:"fixture-a"}});
    const running=coordinator.run(task.id);
    await untilCostFlow(()=>entered,"coordinator entered gateway");
    await hosts[action]!({kind:"team",id:task.id});
    expect(settled).toBe(true);
    await running;
    expect(f.tasks.get(task.id)?.state).toBe(action==="cancel"?"cancelled":"paused");
    expect(f.tasks.listTurns(task.id).every(turn=>turn.status!=="running")).toBe(true);
  }finally{await f.close();}
});

test("a repaired later team attempt can pass while prior failed machine facts remain queryable", async () => {
  const f = await setupCostFlowFixture({ routingFixture: true });
  try {
    configure(f);
    const plan = acceptance(f, "repaired result"), command = await submit(f, "execute_review", plan.id);
    await approve(f, command.commandId);
    await untilCostFlow(() => f.adaptive.get(command.commandId)!.attempts.length === 2 && f.adaptive.get(command.commandId)?.status === "awaiting_plan", "repair ready");
    writeFileSync(join(f.workspace.canonicalPath, "result.txt"), "repaired result");
    await approve(f, command.commandId);
    await untilCostFlow(() => f.adaptive.get(command.commandId)?.status === "completed", "repair verified completion");
    expect(f.adaptive.get(command.commandId)).toMatchObject({ outcome: "verified_success", retries: 1 });
    expect(f.verification.view({ roomId: f.roomIds.work, rootTaskId: command.commandId }).unverifiedPackageIds ?? []).toEqual([]);
  } finally { await f.close(); }
});

test("accepting an explicitly pending local check resumes review and integration without rerunning completed writes",async()=>{
  const f=await setupCostFlowFixture({routingFixture:true});
  try{
    configure(f);writeFileSync(join(f.workspace.canonicalPath,"check.js"),"console.log('local check');");
    const room=f.sessions.get(f.roomIds.work)!;
    f.sessions.updateCollaboration(room.id,{...room.collaboration,assignment:{...room.collaboration.assignment,routing:{...room.collaboration.assignment.routing,limits:{maxRetries:1,maxEscalations:1,maxTotalModelCalls:3}}}});
    const draft=f.verification.prepare({roomId:f.roomIds.work,requestId:"pending-local",artifactPaths:["result.txt"],protectedPaths:[],checks:[{
      id:"build",label:"Local build",kind:"command",required:true,origin:"user",category:"build",parser:"exit_code",definitionPaths:["check.js"],command:{executable:"bun",argv:["check.js"],timeoutMs:1000},
    }]});
    const plan=f.verification.approve(draft.id,"approve-local"),command=await submit(f,"execute_review",plan.id),child=await approve(f,command.commandId);
    await untilCostFlow(()=>f.adaptive.get(command.commandId)?.status==="awaiting_approval","package local approval");
    const item=f.packages.list(child.id)[0]!;
    f.verification.acceptUnverified({roomId:f.roomIds.work,rootTaskId:command.commandId,workPackageId:item.id},"accept-package-unverified");
    await untilCostFlow(()=>f.verification.view({roomId:f.roomIds.work,rootTaskId:command.commandId}).run?.pendingApprovals.length===1,"integration local approval");
    f.verification.acceptUnverified({roomId:f.roomIds.work,rootTaskId:command.commandId},"accept-integration-unverified");
    await untilCostFlow(()=>f.adaptive.get(command.commandId)?.status==="completed","accepted integration completion");
    expect(f.adaptive.get(command.commandId)).toMatchObject({outcome:"completed_unverified"});
    expect(f.tasks.get(child.id)?.state).toBe("completed");
    expect(f.approvals.recoverPending().pending.filter(item=>item.taskId.startsWith("verification:"))).toHaveLength(0);
    expect(f.gatewayCalls.filter(call=>call.purpose==="review")).toHaveLength(1);
    expect(f.adaptive.get(command.commandId)?.attempts).toHaveLength(1);
    expect(f.adaptive.get(command.commandId)?.modelCalls).toBe(3);
    expect(f.db.query("SELECT COUNT(*) AS n FROM tool_calls WHERE name='write_file'").get()).toEqual({n:1});
  }finally{await f.close();}
});
