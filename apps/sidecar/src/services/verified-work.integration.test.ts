import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VerificationCheck, VerificationTarget } from "@socrates/core";
import { setupCostFlowFixture, untilCostFlow } from "./cost-flow-fixture";

type Fixture = Awaited<ReturnType<typeof setupCostFlowFixture>>;
function plan(f: Fixture, check: VerificationCheck, target?: VerificationTarget) {
  const proposed = f.verification.prepare({ roomId:f.roomIds.work, ...target, requestId:crypto.randomUUID(),
    checks:[check], artifactPaths:check.kind === "file" ? [check.path] : ["result.txt"], protectedPaths:[] });
  return f.verification.approve(proposed.id,crypto.randomUUID());
}
const resultCheck: VerificationCheck = {id:"result",label:"Actual written artifact",kind:"file",path:"result.txt",contains:"Written once",required:true};

for (const valid of [true,false]) test(`direct Native execution keeps execution and ${valid ? "passing" : "failing"} verification separate`,async()=>{
  const f=await setupCostFlowFixture();
  try {
    const room=f.sessions.get(f.roomIds.work)!;
    f.sessions.updateCollaboration(room.id,{...room.collaboration,strategy:"single"});
    const approved=plan(f,{...resultCheck,contains:valid?"Written once":"Requirement deliberately not met"});
    const command=await f.commands.submit({roomId:room.id,content:"Write the controlled artifact",intent:"execute",mentions:[],clientRequestId:`direct-verified-${valid}`,verificationPlanId:approved.id});
    await untilCostFlow(()=>f.commands.get(command.commandId)?.status==="completed","direct-terminal");
    const view=f.verification.view({roomId:room.id,rootTaskId:command.commandId});
    expect(view.verificationStatus).toBe(valid?"passed":"failed");
    expect(view.outcome).toBe(valid?"verified_success":"verification_failed");
    expect(view.run?.executionRunId).toBe(command.runId);
    expect(view.run?.evidence[0]?.artifactSnapshotHash).toBe(view.run?.snapshot.hash);
    expect(f.gatewayCalls).toHaveLength(0);
    expect(f.nativeCalls.length).toBeGreaterThan(0);
    if(valid){
      writeFileSync(join(f.workspace.canonicalPath,"result.txt"),"changed after verification");
      expect(f.verification.view(view.target).verificationStatus).toBe("invalidated");
    }
  } finally {await f.close();}
});

test("team blocks dependency before Reviewer, then releases accepted unverified work without replay and runs final integration",async()=>{
  const f=await setupCostFlowFixture();
  try {
    const rootPlan=plan(f,resultCheck);
    const command=await f.commands.submit({roomId:f.roomIds.work,content:"Controlled team verification",intent:"execute",mentions:[],clientRequestId:"team-verification",verificationPlanId:rootPlan.id});
    await untilCostFlow(()=>f.tasks.get(command.taskId!)?.state==="awaiting_plan_approval","plan");
    const first=f.packages.list(command.taskId!)[0]!;
    const target={roomId:f.roomIds.work,rootTaskId:command.commandId,workPackageId:first.id};
    plan(f,{...resultCheck,contains:"Not satisfied"},target);
    const managerPlan=f.tasks.getPlan(command.taskId!)!;
    const response=await f.app.request(`/multi/tasks/${command.taskId}/plan-decisions`,{method:"POST",headers:f.headers,body:JSON.stringify({version:managerPlan.version,hash:managerPlan.contentHash,clientDecisionKey:"approve",decision:"approve_exact_plan"})});
    expect(response.status).toBe(200);
    await untilCostFlow(()=>!f.team.isActive(command.taskId!)&&f.tasks.get(command.taskId!)?.state==="paused","verification-pause");
    expect(f.tasks.get(command.taskId!)?.terminalReason).toBe("verification_required");
    expect(f.packages.get(first.id)?.state).toBe("awaiting_verification");
    expect(f.packages.list(command.taskId!)[1]?.attemptNo).toBe(0);
    expect(f.gatewayCalls.filter(c=>c.purpose==="review")).toHaveLength(0);
    const initialCalls=f.nativeCalls.length;
    const accepted=await f.verification.acceptUnverified(target,"accept-current");
    expect(accepted).toMatchObject({acceptedUnverified:true,outcome:"verification_failed",gatePassed:true});
    await f.team.resume(command.taskId!);
    expect(f.tasks.get(command.taskId!)?.state).toBe("completed");
    expect(f.packages.get(first.id)?.attemptNo).toBe(1);
    expect(f.nativeCalls.length).toBe(initialCalls+1);
    expect(f.verification.view({roomId:f.roomIds.work,rootTaskId:command.commandId})).toMatchObject({verificationStatus:"passed",outcome:"completed_unverified"});
    expect(f.verification.view(target).outcome).not.toBe("verified_success");
    expect(f.db.query("SELECT COUNT(*) AS n FROM tool_calls WHERE name='write_file'").get()).toEqual({n:1});
  }finally{await f.close();}
});

test("unapproved or wrong-room verification cannot start a model invocation",async()=>{
  const f=await setupCostFlowFixture();
  try{
    const proposed=f.verification.prepare({roomId:f.roomIds.work,requestId:"draft",checks:[resultCheck],artifactPaths:["result.txt"],protectedPaths:[]});
    const input={roomId:f.roomIds.work,content:"must not run",intent:"execute" as const,mentions:[],verificationPlanId:proposed.id,clientRequestId:"reject"};
    await expect(f.commands.submit(input)).rejects.toThrow("verification_plan_approval_required");
    const room=f.sessions.create({title:"other",mode:"single_agent",workspaceId:f.workspace.id,primaryAgentId:"fixture-a",agents:f.sessions.get(f.roomIds.work)!.agents.slice(0,1)});
    f.verification.approve(proposed.id,"approved");
    await expect(f.commands.submit({...input,roomId:room.id})).rejects.toThrow("verification_target_mismatch");
    expect(f.gatewayCalls).toHaveLength(0);expect(f.nativeCalls).toHaveLength(0);
  }finally{await f.close();}
});
