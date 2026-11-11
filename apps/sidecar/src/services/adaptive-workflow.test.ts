import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_COLLABORATION_SETTINGS, type RouteCandidate, type RouteWorkflow, type VerificationView } from "@socrates/core";
import { openDb } from "../db";
import { SessionStore } from "../store/session-store";
import { WorkspaceManager } from "../workspace/manager";
import { runMigrations } from "../store/migrations";
import { migrations } from "../store/migrations/index";
import { adaptiveWorkflowMigration } from "../store/migrations/028_adaptive_workflow";
import { resolveRunProfile } from "./run-profile";
import { RoutePolicyService, type RouteDecision } from "./route-policy";
import { AdaptiveWorkflowService, type AdaptiveHostState, type AdaptiveLaunchInput, type AdaptiveWorkflowHosts } from "./adaptive-workflow";
import { BunSqliteCheckpointSaver } from "./reuse/langgraph-checkpoint";
import { routingRoutes } from "../routes/routing";

describe("durable adaptive LangGraph workflow",()=>{
  let base:string,db:Database,roomId:string,rootTaskId:string,decision:RouteDecision,service:AdaptiveWorkflowService;
  let hosts:AdaptiveWorkflowHosts,launches:AdaptiveLaunchInput[],calls:number,allowed:boolean,resumes:number,cancelJoined:boolean;
  let states:Map<string,AdaptiveHostState>,results:AdaptiveHostState[],verify:VerificationView;
  const with28=()=>migrations.some(item=>item.version===28)?migrations:[...migrations,adaptiveWorkflowMigration];
  function candidate(agentId:string,workflow:RouteWorkflow="direct"):RouteCandidate{return {id:`${workflow}:${agentId}`,workflow,resolved:{kind:workflow==="direct"?"direct":"team",agentIds:[agentId]},
    assignments:{managerId:workflow==="plan_execute"||workflow==="team"?"planner":null,executorIds:[agentId],reviewerId:workflow==="execute_review"?"reviewer":null},
    lowAtomic:"100",highAtomic:"500",currency:"USD",costStatus:"reference_estimate",stages:[],priceSnapshotIds:[],modelCalls:{low:1,high:4},reasonCodes:["fixture"],feasible:true,exclusionReasons:[],evidence:"rules_only"};}
  beforeEach(()=>{
    base=mkdtempSync(join(tmpdir(),"socrates-adaptive-"));mkdirSync(join(base,"workspace"));db=openDb(join(base,"facts.db"));runMigrations(db,with28());
    const workspace=new WorkspaceManager(db).select(join(base,"workspace"));
    roomId=new SessionStore(db).create({title:"Adaptive fixture",mode:"single_agent",workspaceId:workspace.id,primaryAgentId:"cheap",agents:[{agentId:"cheap",snapshot:{},executionEligible:true}]}).id;
    rootTaskId=crypto.randomUUID();db.query("INSERT INTO room_commands(id,room_id,client_request_id,fingerprint,input_json,kind,status,created_at,updated_at) VALUES(?,?,?,'fingerprint',?,'direct','pending','now','now')").run(rootTaskId,roomId,rootTaskId,JSON.stringify({content:"Repair the declared acceptance failure"}));
    const members=Object.fromEntries(["cheap","strong","planner","reviewer"].map(agentId=>{const snapshot={providerId:"provider",modelId:agentId,nickname:agentId};return [agentId,{snapshot,profile:resolveRunProfile(agentId,snapshot),provider:{id:"provider",type:"openai_compatible" as const,baseUrl:"http://invalid.local",protocol:"chat_completions"},price:null}];}));
    decision={id:"frozen-decision",rootTaskId,roomId,quoteId:"frozen-quote",createdAt:"frozen-time",bindingHash:"frozen-binding",inputHash:"input",policyVersion:"fixture",preset:"economy",
      features:{selectedPaths:[],fileCount:1,modulePaths:[],independentModuleCount:1,dependencyEdges:[],sharedStateCoupled:false,scripts:[],risk:"ordinary",riskReasons:[],verification:"machine",verificationCheckIds:[],requiredCapabilities:{textInput:true,toolCalling:true,imageInput:false,fileInput:false},inputTokensEstimate:100,contextTokensRequired:1000,scope:"local",evidence:"workspace_metadata",unknowns:[]},
      featuresHash:"feature",metadataHash:"metadata",workspaceIdentity:workspace.identityHash,verification:{planId:null,planHash:null,hasChecks:false},members,
      allowedAgentIds:Object.keys(members),allowedProviderIds:["provider"],lockedAgentIds:[],fallbackAgentIds:["strong"],limits:{maxRetries:1,maxEscalations:1,maxTotalModelCalls:24},collaboration:structuredClone(DEFAULT_COLLABORATION_SETTINGS),budget:null,
      candidates:[candidate("cheap"),candidate("strong")],selectedCandidateId:"direct:cheap",selected:candidate("cheap"),exclusions:[],reasonCodes:["single_sufficient"]};
    launches=[];calls=0;allowed=true;resumes=0;cancelJoined=false;states=new Map();results=[];
    verify={target:{roomId,rootTaskId},plan:null,run:null,verificationStatus:"not_requested",outcome:"completed_unverified",acceptedUnverified:false,gatePassed:true};
    db.exec("CREATE TABLE fixture_children(id TEXT PRIMARY KEY,attempt_id TEXT UNIQUE NOT NULL,state_json TEXT NOT NULL)");
    hosts={
      async launch(input){launches.push(input);calls++;const child={kind:input.workflow==="direct"?"single" as const:"team" as const,id:`child:${input.attemptId}`};const state=results.shift() ?? {status:"completed" as const};
        db.query("INSERT INTO fixture_children(id,attempt_id,state_json) VALUES(?,?,?)").run(child.id,input.attemptId,JSON.stringify(state));states.set(child.id,state);return child;},
      find(attemptId){const row=db.query<{id:string},[string]>("SELECT id FROM fixture_children WHERE attempt_id=?").get(attemptId);return row?{kind:"single",id:row.id}:null;},
      inspect(child){return states.get(child.id) ?? JSON.parse(db.query<{state_json:string},[string]>("SELECT state_json FROM fixture_children WHERE id=?").get(child.id)!.state_json);},
      async resume(child){resumes++;states.set(child.id,{status:"completed"});},
      async cancel(child){await Bun.sleep(10);states.set(child.id,{status:"cancelled"});cancelJoined=true;},
      modelCalls(){return calls;},admit(){return {allowed,reason:allowed?undefined:"budget_insufficient"};},
    };
    service=createService();
  });
  function createService(){return new AdaptiveWorkflowService(db,{get:id=>id===rootTaskId?structuredClone(decision):null},{view:()=>structuredClone(verify),async cancelRoot(){}},hosts,{pollMs:5});}
  afterEach(async()=>{await service.shutdown();db.close();rmSync(base,{recursive:true,force:true});});
  async function run(){service.start(rootTaskId);return (await service.wait(rootTaskId))!;}

  it("unknown graph versions remain readable but cannot reinterpret persisted approval or resume",async()=>{
    results=[{status:"paused_budget",reason:"budget_insufficient"}];await run();
    db.query("UPDATE adaptive_workflows SET state_json=json_set(state_json,'$.version','future-graph','$.status','running'),status='running' WHERE root_task_id=?").run(rootTaskId);
    const before=db.query("SELECT * FROM adaptive_workflows WHERE root_task_id=?").get(rootTaskId);
    service.recoverInterrupted();
    expect(service.get(rootTaskId)).toMatchObject({version:"future-graph",status:"interrupted",reason:"adaptive_workflow_version_incompatible"});
    await expect(service.resume(rootTaskId,"future-resume")).rejects.toThrow("adaptive_workflow_version_incompatible");
    expect(launches).toHaveLength(1);expect(resumes).toBe(0);
    await service.shutdown();expect(db.query("SELECT * FROM adaptive_workflows WHERE root_task_id=?").get(rootTaskId)).toEqual(before);
  });
  it("an approval from an unsupported graph is preserved without authorizing its successor",async()=>{
    decision.limits.maxRetries=0;results=[{status:"failed",reason:"verification_assertion_failed",failureSignature:"first",artifactSnapshotHash:"original"}];
    const paused=await run();expect(paused.pendingApproval).not.toBeNull();
    db.query("UPDATE adaptive_workflows SET state_json=json_set(state_json,'$.version','future-graph') WHERE root_task_id=?").run(rootTaskId);
    const before=db.query("SELECT * FROM adaptive_approvals WHERE root_task_id=?").all(rootTaskId);
    await expect(service.decide(paused.pendingApproval!.id,{requestId:"future-approval",decision:"allow"})).rejects.toThrow("adaptive_workflow_version_incompatible");
    expect(db.query("SELECT * FROM adaptive_approvals WHERE root_task_id=?").all(rootTaskId)).toEqual(before);expect(launches).toHaveLength(1);
  });
  it("turning off new automatic admission leaves frozen workflow resume intact",async()=>{
    results=[{status:"paused_budget",reason:"budget_insufficient"}];await run();
    const previous=process.env.SOCRATES_AUTOMATIC_ADMISSION_ENABLED;
    process.env.SOCRATES_AUTOMATIC_ADMISSION_ENABLED="false";
    try{await service.resume(rootTaskId,"existing-resume");await service.wait(rootTaskId);expect(resumes).toBe(1);expect(service.get(rootTaskId)?.status).toBe("completed");expect(launches).toHaveLength(1);}finally{if(previous===undefined)delete process.env.SOCRATES_AUTOMATIC_ADMISSION_ENABLED;else process.env.SOCRATES_AUTOMATIC_ADMISSION_ENABLED=previous;}
  });
  for(const workflow of ["direct","plan_execute","execute_review","team"] as const)it(`dispatches the frozen ${workflow} host assignment through real checkpointed nodes`,async()=>{
    decision.selected=candidate("cheap",workflow);decision.selectedCandidateId=decision.selected.id;decision.candidates.push(decision.selected);
    const view=await run();expect(view.status).toBe("completed");expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({workflow,assignments:decision.selected.assignments,decisionId:decision.id,remainingModelCalls:24,clientTurnKey:`adaptive:${rootTaskId}:1`});
    expect(db.query("SELECT count(*) AS n FROM lg_checkpoints WHERE thread_id=?").get(`adaptive:${rootTaskId}`)).toMatchObject({n:expect.any(Number)});
    const tuple=await new BunSqliteCheckpointSaver(db).getTuple({configurable:{thread_id:`adaptive:${rootTaskId}`}});
    expect(Object.keys(tuple!.checkpoint.channel_values).filter(key=>!key.startsWith("__"))).toEqual(["rootTaskId"]);
    service.start(rootTaskId);await service.wait(rootTaskId);expect(launches).toHaveLength(1);
  });
  it("repairs once with evidence and stops repeated identical failure without artifact change",async()=>{
    results=[{status:"failed",reason:"verification_assertion_failed",failureSignature:"same",artifactSnapshotHash:"unchanged"},{status:"failed",reason:"verification_assertion_failed",failureSignature:"same",artifactSnapshotHash:"unchanged"}];
    const view=await run();expect(view).toMatchObject({status:"failed",reason:"routing_repeated_failure_without_change",retries:1,escalations:0});
    expect(launches).toHaveLength(2);expect(launches[1]?.kind).toBe("repair");expect(launches[1]?.assignments.executorIds).toEqual(["cheap"]);
    expect(launches[1]?.handoff).toMatchObject({failureSignature:"same",artifactSnapshotHash:"unchanged",failureCategory:"verification"});
  });
  it("bounded repair preserves the originally required independent reviewer",async()=>{
    decision.selected=candidate("cheap","execute_review");decision.selectedCandidateId=decision.selected.id;decision.candidates.push(decision.selected);
    results=[{status:"failed",reason:"verification_assertion_failed",failureSignature:"failure",artifactSnapshotHash:"before"},{status:"completed"}];
    const view=await run();expect(view.status).toBe("completed");expect(launches).toHaveLength(2);
    expect(launches[1]).toMatchObject({workflow:"execute_review",assignments:{executorIds:["cheap"],reviewerId:"reviewer"}});
  });
  for(const reason of ["provider_authentication_failed","verification_environment_unavailable","verification_permission_denied","rate_limit","network_unavailable","tool_outcome_unknown"])it(`does not escalate ${reason}`,async()=>{
    results=[{status:"failed",reason}];const view=await run();expect(view.status).toBe("blocked");expect(launches).toHaveLength(1);expect(view.pendingApproval).toBeNull();
  });
  it("persists a priced fallback approval and launches only the frozen allowed member after exact approval",async()=>{
    decision.limits.maxRetries=0;results=[{status:"failed",reason:"verification_assertion_failed",failureSignature:"first",artifactSnapshotHash:"original"},{status:"completed"}];
    const paused=await run();expect(paused.status).toBe("awaiting_approval");expect(launches).toHaveLength(1);
    expect(paused.pendingApproval).toMatchObject({fromAgentId:"cheap",toAgentId:"strong",estimatedAdditionalCost:{lowAtomic:"100",highAtomic:"500",currency:"USD"}});
    await service.decide(paused.pendingApproval!.id,{requestId:"confirm",decision:"allow"});const complete=await service.wait(rootTaskId);
    expect(complete?.status).toBe("completed");expect(launches[1]?.assignments.executorIds).toEqual(["strong"]);
    await service.decide(paused.pendingApproval!.id,{requestId:"confirm",decision:"allow"});await service.wait(rootTaskId);expect(launches).toHaveLength(2);
    await expect(service.decide(paused.pendingApproval!.id,{requestId:"confirm",decision:"deny"})).rejects.toThrow("adaptive_request_conflict");
  });
  it("denying escalation stops without spending another call",async()=>{
    decision.limits.maxRetries=0;results=[{status:"failed",reason:"verification_assertion_failed"}];const view=await run();
    await service.decide(view.pendingApproval!.id,{requestId:"deny",decision:"deny"});expect(service.get(rootTaskId)).toMatchObject({status:"blocked",reason:"routing_escalation_denied"});expect(launches).toHaveLength(1);
  });
  it("budget admission pauses before dispatch and resumes the same stable pending attempt",async()=>{
    allowed=false;const paused=await run();expect(paused.status).toBe("paused_budget");expect(launches).toHaveLength(0);
    allowed=true;await service.resume(rootTaskId,"top-up");const complete=await service.wait(rootTaskId);expect(complete?.status).toBe("completed");
    expect(complete?.attempts).toHaveLength(1);expect(launches[0]?.attemptId).toBe(paused.attempts[0]?.id);
  });
  it("member revocation or unknown external effects do not masquerade as a budget top-up",async()=>{
    hosts.admit=()=>({allowed:false,reason:"routing_external_outcome_unknown"});
    expect(await run()).toMatchObject({status:"blocked",reason:"routing_external_outcome_unknown"});expect(launches).toHaveLength(0);
  });
  it("a child budget pause resumes its existing native/team identity, not a new attempt",async()=>{
    results=[{status:"paused_budget",reason:"budget_insufficient"}];const paused=await run();expect(paused.status).toBe("paused_budget");
    await service.resume(rootTaskId,"resume-child");expect((await service.wait(rootTaskId))?.status).toBe("completed");expect(resumes).toBe(1);expect(launches).toHaveLength(1);
  });
  it("a native continuation updates its physical run ID without creating a route attempt",async()=>{
    results=[{status:"paused_budget"}];const paused=await run(),old=paused.attempts[0]!.child!;
    hosts.resume=async()=>{resumes++;const next={...old,id:`continued:${old.id}`};states.set(next.id,{status:"completed"});return next;};
    await service.resume(rootTaskId,"continue");const complete=await service.wait(rootTaskId);
    expect(complete?.attempts).toHaveLength(1);expect(complete?.attempts[0]?.child?.id).toBe(`continued:${old.id}`);expect(launches).toHaveLength(1);
  });
  for(const reason of ["routing_member_revoked","routing_model_call_limit","cost_budget_insufficient"])it(`re-admits an existing child before resume and performs no new side effect for ${reason}`,async()=>{
    results=[{status:"paused_budget"}];const paused=await run();
    hosts.admit=input=>{expect(input.attemptId).toBe(paused.attempts[0]!.id);expect(input.candidateId).toBe(paused.attempts[0]!.candidateId);return {allowed:false,reason};};
    const view=await service.resume(rootTaskId,"recheck-before-continuation");
    expect(view).toMatchObject({status:reason.startsWith("cost_budget_")?"paused_budget":"blocked",reason});
    expect(resumes).toBe(0);expect(launches).toHaveLength(1);expect(view.attempts).toHaveLength(1);
    expect(view.attempts[0]?.child).toEqual(paused.attempts[0]!.child);
  });
  it("a satisfied local gate cannot resume a paid reviewer after permission is revoked",async()=>{
    results=[{status:"awaiting_approval"}];const paused=await run(),child=paused.attempts[0]!.child!;
    states.set(child.id,{status:"ready"});hosts.admit=()=>({allowed:false,reason:"routing_egress_revoked"});
    await service.notifyChildProgress(child,"approved-check-after-revocation");
    expect(await service.wait(rootTaskId)).toMatchObject({status:"blocked",reason:"routing_egress_revoked"});
    expect(resumes).toBe(0);expect(launches).toHaveLength(1);
  });
  it("concurrent duplicate resume requests share one durable continuation",async()=>{
    results=[{status:"paused_budget"}];await run();const resume=hosts.resume;hosts.resume=async(child,input)=>{await Bun.sleep(10);await resume(child,input);};
    await Promise.all([service.resume(rootTaskId,"same-resume"),service.resume(rootTaskId,"same-resume")]);
    expect((await service.wait(rootTaskId))?.status).toBe("completed");expect(resumes).toBe(1);expect(launches).toHaveLength(1);
  });
  it("root call limit prevents another attempt even when repair would otherwise be allowed",async()=>{
    decision.limits.maxTotalModelCalls=1;results=[{status:"failed",reason:"verification_assertion_failed"}];
    expect(await run()).toMatchObject({status:"failed",reason:"routing_model_call_limit"});expect(launches).toHaveLength(1);
  });
  it("a physical-call guard cannot be bypassed by offering a monetary top-up",async()=>{
    results=[{status:"paused_budget",reason:"routing_model_call_limit"}];expect(await run()).toMatchObject({status:"blocked",reason:"routing_model_call_limit"});
    await expect(service.resume(rootTaskId,"money-does-not-expand-call-limit")).rejects.toThrow("adaptive_workflow_not_resumable");expect(launches).toHaveLength(1);
  });
  it("shutdown interrupts and joins, then explicit resume uses the frozen child history",async()=>{
    results=[{status:"running"}];let interrupts=0;hosts.interrupt=async child=>{await Bun.sleep(10);interrupts++;states.set(child.id,{status:"interrupted"});};
    service.start(rootTaskId);for(let i=0;launches.length===0&&i<200;i++)await Bun.sleep(5);
    await service.shutdown();expect(interrupts).toBe(1);expect(cancelJoined).toBe(false);expect(service.get(rootTaskId)?.status).toBe("interrupted");
    service=createService();await service.resume(rootTaskId,"resume-after-shutdown");expect((await service.wait(rootTaskId))?.status).toBe("completed");expect(launches).toHaveLength(1);expect(resumes).toBe(1);
  });
  it("shutdown during an asynchronous launch joins and interrupts the late child without user-cancelling it",async()=>{
    let entered=false,release!:()=>void,interrupts=0;
    const gate=new Promise<void>(resolve=>{release=resolve;}),launch=hosts.launch;
    results=[{status:"running"}];
    hosts.launch=async input=>{entered=true;await gate;return launch(input);};
    hosts.interrupt=async child=>{await Bun.sleep(10);interrupts++;states.set(child.id,{status:"interrupted",reason:"routing_shutdown"});};
    service.start(rootTaskId);for(let i=0;!entered&&i<200;i++)await Bun.sleep(5);
    expect(entered).toBe(true);
    const stopping=service.shutdown();await Bun.sleep(10);release();await stopping;
    expect(interrupts).toBe(1);expect(cancelJoined).toBe(false);
    expect(service.get(rootTaskId)).toMatchObject({status:"interrupted",reason:"adaptive_restart_requires_resume"});
    const originalChild=service.get(rootTaskId)!.attempts[0]!.child!;
    expect(states.get(originalChild.id)?.status).toBe("interrupted");
    service=createService();await service.resume(rootTaskId,"resume-late-launched-child");
    expect((await service.wait(rootTaskId))?.status).toBe("completed");expect(launches).toHaveLength(1);expect(resumes).toBe(1);
  });
  it("user cancellation during an asynchronous launch still cancels and joins the late child",async()=>{
    let entered=false,release!:()=>void,interrupts=0;
    const gate=new Promise<void>(resolve=>{release=resolve;}),launch=hosts.launch;
    results=[{status:"running"}];hosts.launch=async input=>{entered=true;await gate;return launch(input);};
    hosts.interrupt=async()=>{interrupts++;};
    service.start(rootTaskId);for(let i=0;!entered&&i<200;i++)await Bun.sleep(5);
    const cancelling=service.cancel(rootTaskId,"cancel-late-launch");await Bun.sleep(10);release();
    const cancelled=await cancelling;
    expect(cancelled.status).toBe("cancelled");expect(cancelJoined).toBe(true);expect(interrupts).toBe(0);expect(launches).toHaveLength(1);
  });
  it("cancellation waits for child shutdown and never dispatches a pending replacement",async()=>{
    results=[{status:"running"}];service.start(rootTaskId);
    for(let i=0;launches.length===0&&i<200;i++)await Bun.sleep(5);
    const cancelled=await service.cancel(rootTaskId,"cancel");expect(cancelJoined).toBe(true);expect(cancelled.status).toBe("cancelled");expect(launches).toHaveLength(1);
    await service.cancel(rootTaskId,"cancel");expect(launches).toHaveLength(1);
  });
  it("verification pause does not replay its already completed execution",async()=>{
    verify={...verify,verificationStatus:"pending",gatePassed:false};const paused=await run();expect(paused.status).toBe("awaiting_verification");
    verify={...verify,verificationStatus:"passed",outcome:"verified_success",gatePassed:true};await service.resume(rootTaskId,"checks-finished");
    expect((await service.wait(rootTaskId))?.outcome).toBe("verified_success");expect(launches).toHaveLength(1);expect(resumes).toBe(0);
  });
  it("approved native/team progress wakes observation without a second resume or host launch",async()=>{
    results=[{status:"awaiting_plan"}];const paused=await run(),child=paused.attempts[0]!.child!;
    states.set(child.id,{status:"completed"});await service.notifyChildProgress(child,"plan-approved");
    expect((await service.wait(rootTaskId))?.status).toBe("completed");expect(resumes).toBe(0);expect(launches).toHaveLength(1);
  });
  it("progress notifications cannot bypass budget or escalation approvals",async()=>{
    results=[{status:"paused_budget"}];const paused=await run();states.set(paused.attempts[0]!.child!.id,{status:"completed"});
    await service.notifyChildProgress(paused.attempts[0]!.child!,"unsolicited-progress");expect(service.get(rootTaskId)?.status).toBe("paused_budget");expect(resumes).toBe(0);
  });
  it("reopens persisted interrupt checkpoints without recomputing route or relaunching the first child",async()=>{
    decision.limits.maxRetries=0;results=[{status:"failed",reason:"verification_assertion_failed",failureSignature:"first",artifactSnapshotHash:"one"}];
    const paused=await run();const firstAttempt=paused.attempts[0]!.id;
    await service.shutdown();db.close();db=new Database(join(base,"facts.db"));service=createService();
    expect(service.recoverInterrupted()).toBe(0);expect(service.get(rootTaskId)?.pendingApproval?.id).toBe(paused.pendingApproval!.id);
    await service.decide(paused.pendingApproval!.id,{requestId:"after-reopen",decision:"allow"});expect((await service.wait(rootTaskId))?.status).toBe("completed");
    expect(launches.map(item=>item.attemptId).filter(id=>id===firstAttempt)).toHaveLength(1);expect(service.get(rootTaskId)?.decisionId).toBe("frozen-decision");
  });
  it("a second Bun process resumes the actual production workflow interrupt without replaying completed execution",async()=>{
    decision.limits.maxRetries=0;results=[{status:"failed",reason:"verification_assertion_failed",failureSignature:"first",artifactSnapshotHash:"original"}];
    const paused=await run();expect(paused.pendingApproval).not.toBeNull();
    writeFileSync(join(base,"decision.json"),JSON.stringify(decision));
    const script=join(base,"resume.ts");
    writeFileSync(script,`import {Database} from "bun:sqlite";
import {AdaptiveWorkflowService} from ${JSON.stringify(join(import.meta.dir,"adaptive-workflow.ts"))};
const db=new Database(process.argv[2]);const decision=JSON.parse(await Bun.file(process.argv[3]).text());const root=decision.rootTaskId;
const hosts={launch:async(input)=>{const id="child:"+input.attemptId;db.query("INSERT INTO fixture_children(id,attempt_id,state_json) VALUES(?,?,?)").run(id,input.attemptId,JSON.stringify({status:"completed"}));return {kind:"single",id};},
find:(attemptId)=>{const row=db.query("SELECT id FROM fixture_children WHERE attempt_id=?").get(attemptId);return row?{kind:"single",id:row.id}:null;},
inspect:(child)=>JSON.parse(db.query("SELECT state_json FROM fixture_children WHERE id=?").get(child.id).state_json),resume:async()=>{},cancel:async()=>{},
modelCalls:()=>db.query("SELECT count(*) AS n FROM fixture_children").get().n,admit:()=>({allowed:true})};
const service=new AdaptiveWorkflowService(db,{get:()=>decision},{view:()=>({target:{roomId:decision.roomId,rootTaskId:root},plan:null,run:null,verificationStatus:"not_requested",outcome:"completed_unverified",acceptedUnverified:false,gatePassed:true}),cancelRoot:async()=>{}},hosts,{pollMs:5});
const before=service.get(root);if(before.pendingApproval)await service.decide(before.pendingApproval.id,{requestId:"process-resume",decision:"allow"});await service.wait(root);
console.log(JSON.stringify({status:service.get(root).status,attempts:service.get(root).attempts.length,calls:hosts.modelCalls(),decision:service.get(root).decisionId}));await service.shutdown();db.close();`);
    const execute=async()=>{
      const proc=Bun.spawn([process.execPath,script,join(base,"facts.db"),join(base,"decision.json")],{stdout:"pipe",stderr:"pipe"});
      const [text,error,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);expect({error,code}).toEqual({error:"",code:0});return JSON.parse(text);
    };
    expect(await execute()).toEqual({status:"completed",attempts:2,calls:2,decision:"frozen-decision"});
    expect(await execute()).toEqual({status:"completed",attempts:2,calls:2,decision:"frozen-decision"});
  });
  it("lost dispatch reply is recovered by durable host identity rather than launched twice",async()=>{
    const normal=hosts.launch;hosts.launch=async input=>{await normal(input);throw new Error("lost-host-reply");};
    expect((await run()).status).toBe("completed");expect(launches).toHaveLength(1);
  });
  it("an unknown dispatch outcome blocks rather than automatically retrying",async()=>{
    hosts.launch=async()=>{throw new Error("connection lost");};expect(await run()).toMatchObject({status:"blocked",reason:"adaptive_dispatch_outcome_unknown"});
    expect(service.get(rootTaskId)?.attempts).toHaveLength(1);
  });
  it("serves durable workflow and exact decision errors from real HTTP routes",async()=>{
    await run();const app=routingRoutes({get:()=>decision,preview:()=>decision},service);
    expect((await app.request(`/tasks/${rootTaskId}`)).status).toBe(200);
    const response=await app.request(`/approvals/not-found/decision`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({requestId:"bad",decision:"allow_session"})});
    expect(response.status).toBe(400);
    const preview=await app.request("/preview",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({roomId,content:"Show candidate exclusions",intent:"execute",mentions:[]})});
    expect(preview.status).toBe(200);expect((await preview.json() as RouteDecision).exclusions).toEqual([]);
  });
  it("preview returns actual policy exclusions without a feasible model or any dispatch",async()=>{
    const sessions=new SessionStore(db),room=sessions.get(roomId)!;
    db.query("UPDATE sessions SET collaboration_json=? WHERE id=?").run(JSON.stringify({...room.collaboration,strategy:"adaptive"}),roomId);
    const app=routingRoutes(new RoutePolicyService(db,sessions,{hasCredentials:()=>false}),service);
    const response=await app.request("/preview",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({roomId,content:"Update local artifact",intent:"execute",mentions:[]})});
    expect(response.status).toBe(200);const value=await response.json() as RouteDecision;
    expect(value.selected).toBeNull();expect(value.exclusions[0]?.reasonCodes).toContain("provider_credentials_unavailable");expect(launches).toHaveLength(0);
    expect(db.query("SELECT count(*) AS n FROM cost_invocations").get()).toEqual({n:0});
  });
});
