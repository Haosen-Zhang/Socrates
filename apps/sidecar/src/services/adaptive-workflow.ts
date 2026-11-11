import type { Database } from "bun:sqlite";
import { Annotation, Command, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import { ADAPTIVE_WORKFLOW_VERSION, classifyRoutingFailure, decideRouteRecovery,
  type AdaptiveAttempt, type AdaptiveChildRef, type AdaptiveCost, type AdaptiveEscalationApproval, type AdaptiveEvidenceHandoff,
  type AdaptiveFailureCategory, type AdaptiveWorkflowView, type RouteCandidate, type RouteLimits, type TaskOutcome, type VerificationView } from "@socrates/core";
import type { RouteDecision, RoutePolicyService } from "./route-policy";
import { BunSqliteCheckpointSaver } from "./reuse/langgraph-checkpoint";
import { EventStore } from "../store/event-store";
import { hashToolInput } from "../tools/executor";
import { redactDiagnostic } from "../security/redaction";

export interface AdaptiveLaunchInput {
  rootTaskId: string; attemptId: string; clientTurnKey: string; decisionId: string; candidateId: string;
  workflow: RouteCandidate["workflow"]; assignments: RouteCandidate["assignments"]; kind: AdaptiveAttempt["kind"];
  handoff: AdaptiveEvidenceHandoff | null; remainingModelCalls: number; limits: RouteLimits; signal: AbortSignal;
}
export interface AdaptiveHostState {
  status: "running" | "ready" | "awaiting_approval" | "awaiting_plan" | "awaiting_verification" | "paused_budget" | "completed" | "failed" | "cancelled" | "interrupted" | "outcome_unknown";
  reason?: string; failureCategory?: AdaptiveFailureCategory; failureSignature?: string | null; artifactSnapshotHash?: string | null;
  evidenceRefs?: string[]; result?: string;
}
export interface AdaptiveWorkflowHosts {
  /** Launch is bound to this stable attempt, never to a fresh random child. */
  launch(input: AdaptiveLaunchInput): Promise<AdaptiveChildRef>;
  /** Read durable host identity after a lost launch reply. Never creates work. */
  find(attemptId: string): AdaptiveChildRef | null | Promise<AdaptiveChildRef | null>;
  inspect(child: AdaptiveChildRef): AdaptiveHostState | Promise<AdaptiveHostState>;
  resume(child: AdaptiveChildRef, input: { requestId: string; signal?: AbortSignal }): AdaptiveChildRef | void | Promise<AdaptiveChildRef | void>;
  cancel(child: AdaptiveChildRef): Promise<void>;
  /** Shutdown preserves resumable native/team history rather than user-cancelling it. */
  interrupt?(child: AdaptiveChildRef): Promise<void>;
  modelCalls(rootTaskId: string): number;
  /** Uses the frozen roster/profile/price and current ledger; the broker also
   * checks the root limit for every physical call inside this child. */
  admit(input: Omit<AdaptiveLaunchInput, "signal">): { allowed: boolean; reason?: string; estimatedAdditionalCost?: AdaptiveCost } | Promise<{ allowed: boolean; reason?: string; estimatedAdditionalCost?: AdaptiveCost }>;
}
export interface AdaptiveVerification {
  view(target: {roomId: string; rootTaskId: string}): VerificationView;
  cancelRoot(roomId: string, rootTaskId: string): Promise<void>;
}
interface RootState extends Omit<AdaptiveWorkflowView, "attempts" | "pendingApproval" | "modelCalls"> { modelCalls: number }
interface Active { controller: AbortController; promise: Promise<void>; cancelling: boolean; stopping: boolean; nodes: Set<Promise<void>> }
const GraphState = Annotation.Root({ rootTaskId: Annotation<string>() });
const TERMINAL = new Set(["completed", "blocked", "failed", "cancelled"]);
const PAUSED = new Set(["awaiting_approval", "awaiting_plan", "awaiting_verification", "paused_budget", "interrupted"]);
const waitForPoll = (signal: AbortSignal, ms: number) => new Promise<void>((resolve,reject) => {
  const finish=()=>{signal.removeEventListener("abort",abort);resolve();};
  const timer=setTimeout(finish,ms);const abort=()=>{clearTimeout(timer);signal.removeEventListener("abort",abort);reject(signal.reason ?? new Error("adaptive_cancelled"));};
  signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
});

/** LangGraph owns resumable control transitions. All domain facts and stable
 * host identities live in SQLite; checkpoint channels contain IDs only. */
export class AdaptiveWorkflowService {
  private readonly active = new Map<string, Active>();
  private readonly actions = new Map<string, Promise<unknown>>();
  private stopping = false;
  private readonly events: EventStore;
  private readonly graph;
  constructor(private readonly db: Database, private readonly routes: Pick<RoutePolicyService,"get">,
    private readonly verification: AdaptiveVerification, private readonly hosts: AdaptiveWorkflowHosts,
    private readonly options: { pollMs?: number; onChanged?: (view:AdaptiveWorkflowView)=>void|Promise<void> } = {}) {
    this.events=new EventStore(db);
    this.graph=new StateGraph(GraphState)
      .addNode("dispatch", async (state,config) => { await this.trackNode(state.rootTaskId,this.dispatch(state.rootTaskId,config.signal!));return {}; })
      .addNode("observe", async (state,config) => { await this.trackNode(state.rootTaskId,this.observe(state.rootTaskId,config.signal!));return {}; })
      .addNode("assess", async state => { await this.trackNode(state.rootTaskId,this.assess(state.rootTaskId));return {}; })
      .addNode("pause", state => { interrupt({rootTaskId:state.rootTaskId});return {}; })
      .addEdge(START,"dispatch")
      .addConditionalEdges("dispatch",state=>this.nextNode(state.rootTaskId),["observe","assess","pause",END])
      .addConditionalEdges("observe",state=>this.nextNode(state.rootTaskId),["observe","assess","pause",END])
      .addConditionalEdges("assess",state=>this.nextNode(state.rootTaskId),["dispatch","pause",END])
      .addEdge("pause","dispatch")
      .compile({checkpointer:new BunSqliteCheckpointSaver(db)});
  }

  start(rootTaskId:string):AdaptiveWorkflowView {
    if(this.stopping)throw new Error("adaptive_service_stopping");
    let current=this.get(rootTaskId);
    if(current)return current;
    const decision=this.requireDecision(rootTaskId),candidate=decision.selected;
    if(!candidate?.feasible)throw new Error("routing_no_feasible_candidate");
    const now=new Date().toISOString();
    const root:RootState={rootTaskId,roomId:decision.roomId,decisionId:decision.id,version:ADAPTIVE_WORKFLOW_VERSION,preset:decision.preset,workflow:candidate.workflow,
      status:"pending",outcome:"completed_unverified",reason:null,limits:decision.limits,retries:0,escalations:0,modelCalls:0,createdAt:now,updatedAt:now,finishedAt:null};
    this.db.transaction(()=>{
      this.db.query("INSERT INTO adaptive_workflows(root_task_id,room_id,decision_id,status,state_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(rootTaskId,root.roomId,root.decisionId,root.status,JSON.stringify(root),now,now);
      this.insertAttempt(this.newAttempt(root,decision,candidate,"initial",null));
      this.appendEvent(root,"routing.workflow.created",{candidateId:candidate.id,workflow:candidate.workflow});
    })();
    this.kick(rootTaskId,false);current=this.get(rootTaskId);return current!;
  }
  get(rootTaskId:string):AdaptiveWorkflowView|null {
    const root=this.root(rootTaskId);if(!root)return null;
    const attempts=this.attempts(rootTaskId),pendingApproval=this.approvals(rootTaskId).find(item=>item.status==="pending") ?? null;
    const modelCalls=this.hosts.modelCalls(rootTaskId);
    let outcome=root.outcome;
    if(root.status==="completed")try{const current=this.verification.view({roomId:root.roomId,rootTaskId});if(outcome==="verified_success"&&current.outcome!=="verified_success")outcome="completed_unverified";}catch{outcome="completed_unverified";}
    return {...root,...(root.version !== ADAPTIVE_WORKFLOW_VERSION && !TERMINAL.has(root.status) ? {status:"interrupted" as const,reason:"adaptive_workflow_version_incompatible"} : {}),outcome,modelCalls,attempts,pendingApproval};
  }
  async wait(rootTaskId:string):Promise<AdaptiveWorkflowView|null>{await this.active.get(rootTaskId)?.promise;return this.get(rootTaskId);}
  /** Explicit host approval/progress notifications wake observation only. They
   * cannot authorize an escalation, spend through a budget pause, or restart a
   * terminal child. Reads never call this method. */
  async notifyChildProgress(child:AdaptiveChildRef,requestId:string):Promise<AdaptiveWorkflowView|null>{
    const row=this.db.query<{root_task_id:string},[string,string]>("SELECT root_task_id FROM adaptive_attempts WHERE json_extract(attempt_json,'$.child.kind')=? AND json_extract(attempt_json,'$.child.id')=? ORDER BY ordinal DESC LIMIT 1").get(child.kind,child.id);
    if(!row)return null;
    return this.notifyVerificationProgress(row.root_task_id,requestId);
  }
  async notifyVerificationProgress(rootTaskId:string,requestId:string):Promise<AdaptiveWorkflowView|null>{
    let root=this.root(rootTaskId);if(!root||!["awaiting_plan","awaiting_approval","awaiting_verification"].includes(root.status)||this.get(rootTaskId)?.pendingApproval)return this.get(rootTaskId);
    await this.active.get(rootTaskId)?.promise;
    root=this.root(rootTaskId);if(!root||!["awaiting_plan","awaiting_approval","awaiting_verification"].includes(root.status)||this.get(rootTaskId)?.pendingApproval)return this.get(rootTaskId);
    return this.resume(rootTaskId,requestId);
  }
  resume(rootTaskId:string,requestId:string):Promise<AdaptiveWorkflowView> {return this.serialize(rootTaskId,()=>this.resumeAction(rootTaskId,requestId));}
  private async resumeAction(rootTaskId:string,requestId:string):Promise<AdaptiveWorkflowView> {
    if(this.stopping)throw new Error("adaptive_service_stopping");
    const root=this.requireRoot(rootTaskId),fingerprint=hashToolInput({action:"resume",rootTaskId});
    this.assertCompatible(root);
    if(this.request(rootTaskId,requestId,fingerprint))return this.get(rootTaskId)!;
    if(TERMINAL.has(root.status))throw new Error("adaptive_workflow_not_resumable");
    if(this.get(rootTaskId)?.pendingApproval)throw new Error("adaptive_escalation_approval_required");
    if(this.active.has(rootTaskId))return this.get(rootTaskId)!;
    const attempt=this.latestAttempt(rootTaskId);
    if(attempt.status==="dispatching"&&!attempt.child){
      const found=await this.hosts.find(attempt.id);
      if(!found){this.stop(root,"adaptive_dispatch_outcome_unknown","blocked");throw new Error("adaptive_dispatch_outcome_unknown");}
      attempt.child=found;attempt.status="running";this.saveAttempt(attempt);
    }
    if(attempt.child){
      const observed=await this.hosts.inspect(attempt.child);
      if(observed.status==="outcome_unknown")throw new Error("adaptive_outcome_unknown_requires_review");
      // Verification approval is a separate exact ToolExecutor operation. A
      // completed child must never restart just because its checks were paused.
      if(["paused_budget","interrupted"].includes(observed.status)){
        if(!await this.admitContinuation(root,attempt))return this.get(rootTaskId)!;
        const resumed=await this.hosts.resume(attempt.child,{requestId});
        if(resumed){attempt.child=resumed;attempt.status="running";this.saveAttempt(attempt);}
      }
    }
    this.saveRequest(rootTaskId,requestId,fingerprint,{accepted:true});
    root.status=attempt.child?"running":"pending";root.reason=null;this.saveRoot(root,"routing.workflow.resumed");
    this.kick(rootTaskId,true);return this.get(rootTaskId)!;
  }
  decide(approvalId:string,input:{requestId:string;decision:"allow"|"deny"}):Promise<AdaptiveWorkflowView>{
    const approval=this.approval(approvalId);if(!approval)return Promise.reject(new Error("adaptive_approval_not_found"));
    return this.serialize(approval.rootTaskId,()=>this.decideAction(approvalId,input));
  }
  private async decideAction(approvalId:string,input:{requestId:string;decision:"allow"|"deny"}):Promise<AdaptiveWorkflowView>{
    if(this.stopping)throw new Error("adaptive_service_stopping");
    const approval=this.approval(approvalId);if(!approval)throw new Error("adaptive_approval_not_found");
    const root=this.requireRoot(approval.rootTaskId),fingerprint=hashToolInput({action:"decide",approvalId,decision:input.decision});
    this.assertCompatible(root);
    if(this.request(root.rootTaskId,input.requestId,fingerprint))return this.get(root.rootTaskId)!;
    if(approval.status!=="pending"||root.status!=="awaiting_approval")throw new Error("adaptive_approval_not_pending");
    if(this.active.has(root.rootTaskId))await this.active.get(root.rootTaskId)!.promise;
    const attempt=this.attempt(approval.attemptId)!;
    if(input.decision==="allow")this.validateEnvelope(this.requireDecision(root.rootTaskId),attempt);
    this.db.transaction(()=>{
      approval.status=input.decision==="allow"?"allowed":"denied";approval.decidedAt=new Date().toISOString();this.saveApproval(approval);
      this.saveRequest(root.rootTaskId,input.requestId,fingerprint,{accepted:true});
      root.status=input.decision==="allow"?"pending":"blocked";root.reason=input.decision==="allow"?null:"routing_escalation_denied";root.outcome=input.decision==="allow"?"completed_unverified":"blocked";
      if(input.decision==="deny")root.finishedAt=new Date().toISOString();
      this.saveRoot(root,"routing.escalation.decided",{approvalId,decision:input.decision});
    })();
    if(input.decision==="allow")this.kick(root.rootTaskId,true);
    return this.get(root.rootTaskId)!;
  }
  cancel(rootTaskId:string,requestId=`cancel:${crypto.randomUUID()}`):Promise<AdaptiveWorkflowView>{return this.serialize(rootTaskId,()=>this.cancelAction(rootTaskId,requestId));}
  private async cancelAction(rootTaskId:string,requestId:string):Promise<AdaptiveWorkflowView>{
    const root=this.requireRoot(rootTaskId),fingerprint=hashToolInput({action:"cancel",rootTaskId});
    if(TERMINAL.has(root.status))return this.get(rootTaskId)!;
    if(this.request(rootTaskId,requestId,fingerprint)){await this.active.get(rootTaskId)?.promise;return this.get(rootTaskId)!;}
    this.saveRequest(rootTaskId,requestId,fingerprint,{accepted:true});
    const active=this.active.get(rootTaskId);if(active){active.cancelling=true;active.controller.abort(new Error("adaptive_cancelled"));}
    let attempt=this.latestAttempt(rootTaskId);const child=attempt.child ?? await this.hosts.find(attempt.id);
    await Promise.all([child?this.hosts.cancel(child):Promise.resolve(),this.verification.cancelRoot(root.roomId,rootTaskId)]);
    await active?.promise;
    attempt=this.latestAttempt(rootTaskId);attempt.status="cancelled";attempt.finishedAt=new Date().toISOString();this.saveAttempt(attempt);
    for(const approval of this.approvals(rootTaskId).filter(item=>item.status==="pending")){approval.status="denied";approval.decidedAt=new Date().toISOString();this.saveApproval(approval);}
    this.stop(this.requireRoot(rootTaskId),"adaptive_cancelled","cancelled");return this.get(rootTaskId)!;
  }
  recoverInterrupted():number {
    const rows=this.db.query<{state_json:string},[]>("SELECT state_json FROM adaptive_workflows WHERE status IN ('pending','running','assessing')").all();
    let recovered=0;
    for(const row of rows){const root=JSON.parse(row.state_json) as RootState;if(root.version!==ADAPTIVE_WORKFLOW_VERSION)continue;recovered++;root.status="interrupted";root.outcome="blocked";root.reason="adaptive_restart_requires_resume";this.saveRoot(root,"routing.workflow.interrupted");}
    return recovered;
  }
  async shutdown():Promise<void>{
    this.stopping=true;
    await Promise.allSettled([...this.actions.values()]);
    const roots=this.db.query<{root_task_id:string},[]>("SELECT root_task_id FROM adaptive_workflows WHERE status NOT IN ('completed','failed','blocked','cancelled')").all();
    await Promise.all(roots.map(async({root_task_id:rootTaskId})=>{
      const active=this.active.get(rootTaskId);
      if(this.root(rootTaskId)?.version!==ADAPTIVE_WORKFLOW_VERSION)return;
      if(active){active.stopping=true;active.controller.abort(new Error("adaptive_shutdown"));}
      const root=this.requireRoot(rootTaskId),attempt=this.latestAttempt(rootTaskId),child=attempt.child ?? await this.hosts.find(attempt.id);
      await Promise.all([child?(this.hosts.interrupt?.(child) ?? this.hosts.cancel(child)):Promise.resolve(),this.verification.cancelRoot(root.roomId,rootTaskId)]);await active?.promise;
      const latest=this.requireRoot(rootTaskId);if(!TERMINAL.has(latest.status)&&!this.get(rootTaskId)?.pendingApproval){latest.status="interrupted";latest.outcome="blocked";latest.reason="adaptive_restart_requires_resume";this.saveRoot(latest,"routing.workflow.interrupted");}
    }));
  }

  private assertCompatible(root:RootState):void {
    if(root.version!==ADAPTIVE_WORKFLOW_VERSION)throw new Error("adaptive_workflow_version_incompatible");
  }
  private kick(rootTaskId:string,resume:boolean):void {
    this.assertCompatible(this.requireRoot(rootTaskId));
    if(this.active.has(rootTaskId))return;
    const controller=new AbortController();
    const active:Active={controller,cancelling:false,stopping:false,promise:Promise.resolve(),nodes:new Set()};
    active.promise=Promise.resolve().then(async()=>{
      const config={configurable:{thread_id:`adaptive:${rootTaskId}`},signal:controller.signal,recursionLimit:100};
      const checkpoint=await this.graph.getState(config);
      const input=checkpoint.next?.length?(resume&&checkpoint.next.includes("pause")?new Command({resume:true}):null):{rootTaskId};
      await this.graph.invoke(input,config);
    }).catch(error=>{
      if(active.cancelling||active.stopping)return;
      const root=this.requireRoot(rootTaskId);root.status="interrupted";root.outcome="blocked";root.reason=redactDiagnostic(error);this.saveRoot(root,"routing.workflow.interrupted");
    }).finally(async()=>{
      // LangGraph may reject invoke on abort before an asynchronous node has
      // returned. Retain ownership until its late child is stopped and joined.
      await Promise.allSettled([...active.nodes]);
      this.active.delete(rootTaskId);const view=this.get(rootTaskId);if(view)await this.options.onChanged?.(view);
    });
    this.active.set(rootTaskId,active);
  }
  private async trackNode(rootTaskId:string,work:Promise<void>):Promise<void>{
    const active=this.active.get(rootTaskId);active?.nodes.add(work);
    try{await work;}finally{active?.nodes.delete(work);}
  }
  private nextNode(rootTaskId:string):"dispatch"|"observe"|"assess"|"pause"|typeof END {
    const root=this.requireRoot(rootTaskId);
    if(TERMINAL.has(root.status))return END;
    if(PAUSED.has(root.status))return "pause";
    if(root.status==="assessing")return "assess";
    return root.status==="pending"?"dispatch":"observe";
  }
  private async dispatch(rootTaskId:string,signal:AbortSignal):Promise<void>{
    signal.throwIfAborted();const root=this.requireRoot(rootTaskId),decision=this.requireDecision(rootTaskId),attempt=this.latestAttempt(rootTaskId);
    if(TERMINAL.has(root.status)||PAUSED.has(root.status))return;
    if(attempt.child){root.status="running";this.saveRoot(root,"routing.attempt.observing");return;}
    if(attempt.status==="dispatching"){
      const found=await this.hosts.find(attempt.id);
      if(!found){this.stop(root,"adaptive_dispatch_outcome_unknown","blocked");return;}
      attempt.child=found;attempt.status="running";this.saveAttempt(attempt);root.status="running";this.saveRoot(root,"routing.attempt.recovered");return;
    }
    this.validateEnvelope(decision,attempt);
    const remainingModelCalls=root.limits.maxTotalModelCalls-this.hosts.modelCalls(rootTaskId);
    if(remainingModelCalls<=0){this.stop(root,"routing_model_call_limit","blocked");return;}
    const input:AdaptiveLaunchInput={rootTaskId,attemptId:attempt.id,clientTurnKey:attempt.clientTurnKey,decisionId:decision.id,candidateId:attempt.candidateId,
      workflow:attempt.workflow,assignments:attempt.assignments,kind:attempt.kind,handoff:attempt.handoff,remainingModelCalls,limits:root.limits,signal};
    const admission=await this.hosts.admit(input);signal.throwIfAborted();
    if(!admission.allowed){
      const reason=admission.reason ?? "routing_attempt_admission_required";
      if(/budget|cost_admission/u.test(reason)){root.status="paused_budget";root.reason=reason;root.outcome="blocked";this.saveRoot(root,"routing.attempt.admission_blocked");}
      else this.stop(root,reason,"blocked");
      return;
    }
    if(admission.estimatedAdditionalCost)attempt.estimatedAdditionalCost=admission.estimatedAdditionalCost;
    attempt.status="dispatching";attempt.startedAt=new Date().toISOString();this.saveAttempt(attempt);root.status="running";root.reason=null;this.saveRoot(root,"routing.attempt.dispatching",{attemptId:attempt.id});
    try {
      const child=await this.hosts.launch(input);attempt.child=child;attempt.status="running";this.saveAttempt(attempt);
      if(signal.aborted){
        // The child can acquire its durable identity while launch is awaiting
        // history persistence. Preserve shutdown semantics across that window.
        if(this.active.get(rootTaskId)?.stopping&&this.hosts.interrupt)await this.hosts.interrupt(child);
        else await this.hosts.cancel(child);
        signal.throwIfAborted();
      }
      this.saveRoot(this.requireRoot(rootTaskId),"routing.attempt.started",{attemptId:attempt.id,child});
    }catch(error){
      if(signal.aborted)throw error;
      const child=await this.hosts.find(attempt.id);
      if(child){attempt.child=child;attempt.status="running";this.saveAttempt(attempt);return;}
      attempt.reason=redactDiagnostic(error);attempt.failureCategory="outcome_unknown";this.saveAttempt(attempt);this.stop(root,"adaptive_dispatch_outcome_unknown","blocked");
    }
  }
  private async observe(rootTaskId:string,signal:AbortSignal):Promise<void>{
    const attempt=this.latestAttempt(rootTaskId);if(!attempt.child)throw new Error("adaptive_child_missing");
    while(true){
      signal.throwIfAborted();const observed=await this.hosts.inspect(attempt.child);signal.throwIfAborted();
      const root=this.requireRoot(rootTaskId);
      if(observed.status==="running"){await waitForPoll(signal,this.options.pollMs ?? 100);continue;}
      if(observed.status==="ready"){
        // Explicit approval/acceptance has satisfied a child gate. Continue its
        // existing owner; this is neither another route attempt nor a retry.
        if(!await this.admitContinuation(root,attempt))return;
        signal.throwIfAborted();
        const resumed=await this.hosts.resume(attempt.child!,{requestId:`gate:${attempt.id}`,signal});
        if(resumed){attempt.child=resumed;this.saveAttempt(attempt);}
        continue;
      }
      if(["awaiting_approval","awaiting_plan","awaiting_verification","paused_budget","interrupted"].includes(observed.status)){
        if(observed.reason?.includes("routing_model_call_limit")){this.stop(root,"routing_model_call_limit","blocked");return;}
        root.status=observed.status as RootState["status"];root.reason=observed.reason ?? `adaptive_${observed.status}`;root.outcome="blocked";this.saveRoot(root,"routing.attempt.paused");return;
      }
      attempt.status=observed.status==="completed"?"completed":observed.status==="cancelled"?"cancelled":"failed";
      attempt.reason=observed.reason;attempt.failureCategory=observed.failureCategory ?? (observed.status==="outcome_unknown"?"outcome_unknown":undefined);
      attempt.failureSignature=observed.failureSignature;attempt.artifactSnapshotHash=observed.artifactSnapshotHash;
      attempt.evidenceRefs=observed.evidenceRefs?.slice(0,100);attempt.result=observed.result?.slice(0,8_000);attempt.finishedAt=new Date().toISOString();this.saveAttempt(attempt);
      root.status="assessing";this.saveRoot(root,"routing.attempt.observed",{attemptId:attempt.id,hostStatus:observed.status});return;
    }
  }
  private async admitContinuation(root:RootState,attempt:AdaptiveAttempt):Promise<boolean>{
    const decision=this.requireDecision(root.rootTaskId);this.validateEnvelope(decision,attempt);
    const admission=await this.hosts.admit({rootTaskId:root.rootTaskId,attemptId:attempt.id,clientTurnKey:attempt.clientTurnKey,
      decisionId:decision.id,candidateId:attempt.candidateId,workflow:attempt.workflow,assignments:attempt.assignments,kind:attempt.kind,handoff:attempt.handoff,
      remainingModelCalls:Math.max(0,root.limits.maxTotalModelCalls-this.hosts.modelCalls(root.rootTaskId)),limits:root.limits});
    if(admission.allowed)return true;
    const reason=admission.reason ?? "routing_attempt_admission_required";
    if(/budget|cost_admission/u.test(reason)){root.status="paused_budget";root.reason=reason;root.outcome="blocked";this.saveRoot(root,"routing.continuation.admission_blocked");}
    else this.stop(root,reason,"blocked");
    return false;
  }
  private async assess(rootTaskId:string):Promise<void>{
    const root=this.requireRoot(rootTaskId),attempt=this.latestAttempt(rootTaskId),decision=this.requireDecision(rootTaskId);
    const evidence=this.verification.view({roomId:root.roomId,rootTaskId});
    if(attempt.status==="cancelled"){this.stop(root,"adaptive_child_cancelled","cancelled");return;}
    if(attempt.status==="completed"&&evidence.gatePassed){root.status="completed";root.outcome=evidence.outcome;root.reason=null;root.finishedAt=new Date().toISOString();this.saveRoot(root,"routing.workflow.completed");return;}
    if(attempt.status==="completed"&&["pending","running"].includes(evidence.verificationStatus)){
      root.status="awaiting_verification";root.reason=evidence.run?.reason ?? "verification_pending";root.outcome="completed_unverified";this.saveRoot(root,"routing.verification.paused");return;
    }
    const failed=evidence.run?.evidence.find(item=>item.status!=="passed");
    const reason=(attempt.status==="completed"?failed?.reason ?? evidence.run?.reason ?? attempt.reason:attempt.reason ?? failed?.reason ?? evidence.run?.reason) ?? "adaptive_execution_failed";
    const category=classifyRoutingFailure(reason,attempt.failureCategory);
    const signature=attempt.failureSignature ?? evidence.run?.failureSignature ?? failed?.failureSignature ?? hashToolInput({category,reason});
    const artifactHash=attempt.artifactSnapshotHash ?? evidence.run?.snapshot.hash ?? null;
    attempt.failureCategory=category;attempt.failureSignature=signature;attempt.artifactSnapshotHash=artifactHash;attempt.reason=reason;this.saveAttempt(attempt);
    const handoff=this.handoff(root,attempt,evidence,reason);
    const used=new Set(this.attempts(rootTaskId).flatMap(item=>item.assignments.executorIds));
    const recovery=decideRouteRecovery({category,failureSignature:signature,artifactSnapshotHash:artifactHash,previous:this.attempts(rootTaskId).filter(item=>item.ordinal<attempt.ordinal),
      limits:root.limits,retries:root.retries,escalations:root.escalations,modelCalls:this.hosts.modelCalls(rootTaskId),fallbackAgentIds:decision.fallbackAgentIds.filter(id=>decision.allowedAgentIds.includes(id)&&!used.has(id))});
    if(recovery.action==="stop"){this.stop(root,recovery.reason,category==="verification"?"failed":"blocked",category==="verification"?"verification_failed":"blocked");return;}
    const agentId=recovery.agentId ?? attempt.assignments.executorIds[0]!;
    const candidate=this.recoveryCandidate(decision,agentId,attempt,recovery.action);
    if(!candidate){this.stop(root,"routing_frozen_fallback_candidate_unavailable","blocked");return;}
    const next=this.newAttempt(root,decision,candidate,recovery.action==="repair"?"repair":"escalation",handoff);
    if(recovery.action==="repair"){
      root.retries++;root.status="pending";root.reason=recovery.reason;this.insertAttempt(next);this.saveRoot(root,"routing.repair.planned",{attemptId:next.id});return;
    }
    root.escalations++;root.status="awaiting_approval";root.reason=recovery.reason;
    const approval:AdaptiveEscalationApproval={id:crypto.randomUUID(),rootTaskId,attemptId:next.id,fromAgentId:attempt.assignments.executorIds[0]!,toAgentId:agentId,
      reason:recovery.reason,status:"pending",estimatedAdditionalCost:next.estimatedAdditionalCost,handoff,createdAt:new Date().toISOString(),decidedAt:null};
    this.db.transaction(()=>{this.insertAttempt(next);this.db.query("INSERT INTO adaptive_approvals(id,root_task_id,attempt_id,status,approval_json) VALUES(?,?,?,?,?)").run(approval.id,rootTaskId,next.id,approval.status,JSON.stringify(approval));this.saveRoot(root,"routing.escalation.proposed",{approvalId:approval.id,attemptId:next.id});})();
  }
  private recoveryCandidate(decision:RouteDecision,agentId:string,previous:AdaptiveAttempt,action:"repair"|"escalate"):RouteCandidate|null {
    if(action==="repair")return decision.candidates.find(item=>item.id===previous.candidateId) ?? null;
    const assignments={...previous.assignments,executorIds:[agentId,...previous.assignments.executorIds.slice(1)]};
    // A frozen fallback may have been unaffordable at initial quotation. Its
    // immutable price can be re-admitted after an explicit top-up. Other hard
    // exclusions remain binding, and required Manager/Reviewer roles remain.
    return decision.candidates.find(item=>item.workflow===previous.workflow
      && hashToolInput(item.assignments)===hashToolInput(assignments)
      && (item.feasible||item.exclusionReasons.every(reason=>reason==="workflow_budget_insufficient"))) ?? null;
  }
  private validateEnvelope(decision:RouteDecision,attempt:AdaptiveAttempt):void {
    const ids=[attempt.assignments.managerId,...attempt.assignments.executorIds,attempt.assignments.reviewerId].filter((id):id is string=>!!id);
    if(!ids.length||ids.some(id=>!decision.allowedAgentIds.includes(id)||!decision.members[id]||!decision.allowedProviderIds.includes(decision.members[id]!.provider.id)))throw new Error("routing_envelope_violation");
    if(attempt.kind==="escalation"&&attempt.assignments.executorIds.some(id=>!decision.fallbackAgentIds.includes(id)))throw new Error("routing_fallback_not_authorized");
    if(attempt.decisionId!==decision.id)throw new Error("routing_decision_changed");
  }
  private newAttempt(root:RootState,decision:RouteDecision,candidate:RouteCandidate,kind:AdaptiveAttempt["kind"],handoff:AdaptiveEvidenceHandoff|null):AdaptiveAttempt {
    const ordinal=this.attempts(root.rootTaskId).length+1,id=`adaptive:${root.rootTaskId}:${ordinal}`;
    return {id,rootTaskId:root.rootTaskId,ordinal,clientTurnKey:id,decisionId:decision.id,candidateId:candidate.id,kind,workflow:candidate.workflow,assignments:structuredClone(candidate.assignments),status:"pending",child:null,handoff,
      estimatedAdditionalCost:{lowAtomic:candidate.lowAtomic,highAtomic:candidate.highAtomic,currency:candidate.currency},createdAt:new Date().toISOString(),startedAt:null,finishedAt:null};
  }
  private handoff(root:RootState,attempt:AdaptiveAttempt,evidence:VerificationView,reason:string):AdaptiveEvidenceHandoff {
    const row=this.db.query<{input_json:string},[string]>("SELECT input_json FROM room_commands WHERE id=?").get(root.rootTaskId),input=row?JSON.parse(row.input_json) as {content?:string}:{};
    const decision=this.requireDecision(root.rootTaskId);
    return {objective:(input.content ?? "").slice(0,20_000),constraints:[`workspace:${decision.workspaceIdentity}`,`verification_plan:${evidence.plan?.hash ?? "none"}`,...decision.reasonCodes],
      completedAttemptIds:this.attempts(root.rootTaskId).filter(item=>item.status==="completed").map(item=>item.id),failureCategory:attempt.failureCategory ?? "unknown",failureSignature:attempt.failureSignature ?? null,
      artifactSnapshotHash:attempt.artifactSnapshotHash ?? null,evidenceRefs:[...new Set([...(attempt.evidenceRefs ?? []),...(evidence.run?.evidence.flatMap(item=>[item.id,item.stdoutRef,item.stderrRef].filter((value):value is string=>!!value)) ?? [])])],
      diagnostics:redactDiagnostic([reason,...(attempt.result?[attempt.result]:[]),...(evidence.run?.evidence.filter(item=>item.status!=="passed").map(item=>item.diagnostics ?? item.reason) ?? [])].join("\n")).slice(0,8_000)};
  }
  private requireDecision(rootTaskId:string):RouteDecision{const value=this.routes.get(rootTaskId);if(!value)throw new Error("routing_decision_not_found");return value;}
  private root(id:string):RootState|null{const row=this.db.query<{state_json:string},[string]>("SELECT state_json FROM adaptive_workflows WHERE root_task_id=?").get(id);return row?JSON.parse(row.state_json):null;}
  private requireRoot(id:string){const root=this.root(id);if(!root)throw new Error("adaptive_workflow_not_found");return root;}
  private attempts(id:string):AdaptiveAttempt[]{return this.db.query<{attempt_json:string},[string]>("SELECT attempt_json FROM adaptive_attempts WHERE root_task_id=? ORDER BY ordinal").all(id).map(row=>JSON.parse(row.attempt_json));}
  private latestAttempt(id:string):AdaptiveAttempt{const value=this.attempts(id).at(-1);if(!value)throw new Error("adaptive_attempt_not_found");return value;}
  private attempt(id:string):AdaptiveAttempt|null{const row=this.db.query<{attempt_json:string},[string]>("SELECT attempt_json FROM adaptive_attempts WHERE id=?").get(id);return row?JSON.parse(row.attempt_json):null;}
  private approvals(id:string):AdaptiveEscalationApproval[]{return this.db.query<{approval_json:string},[string]>("SELECT approval_json FROM adaptive_approvals WHERE root_task_id=? ORDER BY rowid").all(id).map(row=>JSON.parse(row.approval_json));}
  private approval(id:string):AdaptiveEscalationApproval|null{const row=this.db.query<{approval_json:string},[string]>("SELECT approval_json FROM adaptive_approvals WHERE id=?").get(id);return row?JSON.parse(row.approval_json):null;}
  private insertAttempt(attempt:AdaptiveAttempt){this.db.query("INSERT INTO adaptive_attempts(id,root_task_id,ordinal,status,attempt_json) VALUES(?,?,?,?,?)").run(attempt.id,attempt.rootTaskId,attempt.ordinal,attempt.status,JSON.stringify(attempt));}
  private saveAttempt(attempt:AdaptiveAttempt){this.db.query("UPDATE adaptive_attempts SET status=?,attempt_json=? WHERE id=?").run(attempt.status,JSON.stringify(attempt),attempt.id);}
  private saveApproval(approval:AdaptiveEscalationApproval){this.db.query("UPDATE adaptive_approvals SET status=?,approval_json=? WHERE id=?").run(approval.status,JSON.stringify(approval),approval.id);}
  private stop(root:RootState,reason:string,status:"blocked"|"failed"|"cancelled",outcome?:TaskOutcome){root.status=status;root.reason=reason;root.outcome=outcome ?? status;root.finishedAt=new Date().toISOString();this.saveRoot(root,"routing.workflow.stopped");}
  private saveRoot(root:RootState,type:string,payload:Record<string,unknown>={}){root.updatedAt=new Date().toISOString();root.modelCalls=this.hosts.modelCalls(root.rootTaskId);
    this.db.query("UPDATE adaptive_workflows SET status=?,state_json=?,updated_at=? WHERE root_task_id=?").run(root.status,JSON.stringify(root),root.updatedAt,root.rootTaskId);this.appendEvent(root,type,payload);}
  private appendEvent(root:RootState,type:string,payload:Record<string,unknown>){this.events.appendInTransaction({eventId:`${type}:${crypto.randomUUID()}`,sessionId:root.roomId,taskId:root.rootTaskId,type,
    payload:{rootTaskId:root.rootTaskId,decisionId:root.decisionId,status:root.status,outcome:root.outcome,reason:root.reason,...payload}});}
  private request(rootTaskId:string,requestId:string,fingerprint:string){if(typeof requestId!=="string"||!requestId.trim()||requestId.length>300)throw new Error("adaptive_request_invalid");
    const row=this.db.query<{fingerprint:string},[string,string]>("SELECT fingerprint FROM adaptive_requests WHERE root_task_id=? AND request_id=?").get(rootTaskId,requestId);if(row&&row.fingerprint!==fingerprint)throw new Error("adaptive_request_conflict");return !!row;}
  private saveRequest(rootTaskId:string,requestId:string,fingerprint:string,result:unknown){this.db.query("INSERT INTO adaptive_requests(root_task_id,request_id,fingerprint,result_json) VALUES(?,?,?,?)").run(rootTaskId,requestId,fingerprint,JSON.stringify(result));}
  private serialize<T>(rootTaskId:string,operation:()=>Promise<T>):Promise<T>{
    const previous=this.actions.get(rootTaskId);
    const next=(previous?previous.catch(()=>{}):Promise.resolve()).then(operation);
    this.actions.set(rootTaskId,next);
    return next.finally(()=>{if(this.actions.get(rootTaskId)===next)this.actions.delete(rootTaskId);});
  }
}
