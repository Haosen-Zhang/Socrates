import { expect,test } from "bun:test";
import { setupCostFlowFixture,untilCostFlow } from "./cost-flow-fixture";

test("a stopped child does not allow deleting or rewinding a still-pending routed task",async()=>{
  const f=await setupCostFlowFixture({routingFixture:true});
  try{
    const room=f.sessions.get(f.roomIds.work)!;
    f.sessions.updateCollaboration(room.id,{...room.collaboration,strategy:"single",assignment:{...room.collaboration.assignment,routing:{...room.collaboration.assignment.routing,mode:"manual",fallbackAgentIds:["fixture-b"],limits:{maxRetries:0,maxEscalations:1,maxTotalModelCalls:10}}}});
    const draft=f.verification.prepare({roomId:room.id,requestId:crypto.randomUUID(),checks:[{id:"required",label:"Required result",kind:"file",path:"result.txt",contains:"missing marker",required:true}],artifactPaths:["result.txt"],protectedPaths:[]});
    f.verification.approve(draft.id,crypto.randomUUID());
    const root=await f.commands.submit({roomId:room.id,content:"Produce the controlled result",intent:"execute",mentions:[],clientRequestId:crypto.randomUUID(),verificationPlanId:draft.id});
    await untilCostFlow(()=>f.adaptive.get(root.commandId)?.status==="awaiting_approval","pending member change");
    const messages=f.sessions.listMessages(room.id),before=JSON.stringify(messages);
    expect(messages.length).toBeGreaterThan(0);
    expect(()=>f.sessions.bindWorkspace(room.id,f.workspace.id)).toThrow("active_session_workspace_locked");
    expect(()=>f.sessions.archive(room.id,true)).toThrow("active_session_archive_locked");
    await expect(f.sessions.remove(room.id)).rejects.toThrow("active_session_delete_locked");
    await expect(f.sessions.rewind(room.id,messages[0]!.id)).rejects.toThrow("active_session_rewind_locked");
    expect(JSON.stringify(f.sessions.listMessages(room.id))).toBe(before);
    await f.adaptive.cancel(root.commandId,"cancel-before-archiving");
    expect(f.sessions.archive(room.id,true).archived).toBe(true);
    expect(JSON.stringify(f.sessions.listMessages(room.id))).toBe(before);
  }finally{await f.close();}
});
