import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setupCostFlowFixture, untilCostFlow } from '../apps/sidecar/src/services/cost-flow-fixture';
// Temporary database/workspace and controlled transport only; never opens the user store.
const f=await setupCostFlowFixture({routingFixture:true,missingFirstNativeUsage:true,nativeToolCalls:()=>[]});
f.sessions.rename(f.roomIds.work,'M06 acceptance lab');
const squad=f.squads.create({workspaceId:f.workspace.id,name:'Evidence squad',avatar:null,description:'Synthetic M06 review',instructions:'Keep evidence current',leaderAgentId:'fixture-a',members:[{agentId:'fixture-a',responsibility:'Lead'},{agentId:'fixture-b',responsibility:'Build'}]});
const alternative=f.squads.create({...squad,name:'Alternative squad',leaderAgentId:'fixture-b',routingPreset:'custom'});
const create=(title:string)=>f.workItems.create({workspaceId:f.workspace.id,title,objective:'Inspect context.txt',acceptanceCriteria:['Human review independent evidence'],ownerKind:'user',priority:'normal'});
async function launch(title:string,ownerKind:'agent'|'squad',ownerId:string,budget?:{mode:'strict_admission';limitAtomic:string}){const item=create(title),preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind,ownerId,budget});await f.workItemLaunch.start(item.id,{previewId:preview.id,expectedRevision:item.revision,clientRequestId:title});return {id:item.id,roomId:preview.executionRoomId};}
const verified=await launch('Verified result with unknown price','agent','fixture-a');
await untilCostFlow(()=>f.workItems.get(verified.id)?.workflow==='in_review','completed');
const root=f.workItems.get(verified.id)!.currentRun!.commandId!,target={roomId:verified.roomId,rootTaskId:root};
const plan=f.verification.prepare({...target,requestId:'plan',checks:[{id:'file',label:'Context exists',kind:'file',path:'context.txt',required:true,origin:'user'}],artifactPaths:['context.txt'],protectedPaths:[]});f.verification.approve(plan.id,'approve');await f.verification.verify(target,{requestId:'verify'});
f.workItems.review(verified.id,f.workItems.get(verified.id)!.revision,'accept');
const team=await launch('Squad planning evidence','squad',squad.id);await untilCostFlow(()=>f.workItems.get(team.id)?.currentRun?.commandStatus==='awaiting_plan_approval','plan');
const stopped=await launch('Budget stopped evidence','agent','fixture-a',{mode:'strict_admission',limitAtomic:'0'});await untilCostFlow(()=>f.workItems.get(stopped.id)?.currentRun?.commandStatus==='interrupted','budget');
f.app.post('/__m06/change-artifact',c=>{writeFileSync(join(f.workspace.canonicalPath,'context.txt'),'changed synthetic artifact');return c.json({changed:true});});
f.app.get('/__m06/calls',c=>c.json({native:f.nativeCalls.length,gateway:f.gatewayCalls.length}));
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:f.app.fetch,idleTimeout:0});
const path='/private/tmp/socrates-multica-m06.json';writeFileSync(path,JSON.stringify({source:'synthetic-multica-m06',pid:process.pid,port:server.port,token:f.token,workspaceId:f.workspace.id,roomId:f.roomIds.work,squadId:squad.id,alternativeId:alternative.id,verified,team,stopped}));
console.log('M06 synthetic fixture ready');
let closing=false;for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>{if(closing)return;closing=true;server.stop(true);void f.close().finally(()=>{try{unlinkSync(path);}catch{}process.exit(0);});});
