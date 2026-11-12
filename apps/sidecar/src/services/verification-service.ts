import { assertTaskWorkflowCompatible } from "./workflow-compatibility";
import type { Database } from "bun:sqlite";
import Ajv from "ajv";
import { evaluatePermission, verificationConclusion, type CheckEvidence, type PrepareVerificationInput, type VerificationCheck, type VerificationPlan, type VerificationRun, type VerificationTarget, type VerificationView, type VerifyOptions, type ToolContext } from "@socrates/core";
import type { SessionStore } from "../store/session-store";
import type { WorkspaceManager } from "../workspace/manager";
import type { WorkspaceLeaseManager } from "../workspace/leases";
import type { ApprovalManager } from "../approvals/manager";
import type { EventStore } from "../store/event-store";
import type { ExecutionEventStore } from "../store/execution-event-store";
import { ToolOutputStore } from "../tools/output-store";
import { ToolRegistry } from "../tools/registry";
import { ToolExecutor, hashToolInput, type ToolExecutionRecord } from "../tools/executor";
import { createNativeBuiltinTools } from "../tools/native-builtins";
import type { WorkspaceCommandRunner, StructuredCommandResult } from "../tools/workspace-command-runner";
import { WorkspacePathPolicy } from "../workspace/path-policy";
import { redactDiagnostic } from "../security/redaction";
import { captureVerificationSnapshot, changedVerificationPaths, discoverVerificationChecks, protectedVerificationPaths, verificationPath } from "./verification-artifacts";
import { parseVerificationCommand, stableVerificationDiagnostic } from "./verification-evidence";

const RUNNER_VERSION = "socrates-verification/1";
const ENVIRONMENT = { network: "denied", credentials: "not_inherited", cwd: "workspace_relative", shell: "false" };
type StoredPlan = { plan_json: string };
type StoredRun = { run_json: string };
type StoredAcceptance = { id: string; snapshot_hash: string };
export interface VerificationServiceOptions {
  /** Replaces only OS process isolation in controlled tests. Business services remain real. */
  commandRunner?: WorkspaceCommandRunner;
  onChanged?: (view: VerificationView) => void | Promise<void>;
}
interface ActiveVerification { controller: AbortController; promise: Promise<VerificationView> }

/** SQLite owns verification facts. This service invokes existing tool policy,
 * approval, command supervision and output capture, without a model or shell. */
export class VerificationService {
  private readonly active = new Map<string, ActiveVerification>();
  private readonly schemas = new Ajv({ strict: true, allErrors: true, validateFormats: true, ownProperties: true });
  constructor(private readonly db: Database, private readonly sessions: SessionStore, private readonly workspaces: WorkspaceManager,
    private readonly leases: WorkspaceLeaseManager, private readonly approvals: ApprovalManager, private readonly events: EventStore,
    private readonly executionEvents: ExecutionEventStore, private readonly outputs: ToolOutputStore,
    private readonly options: VerificationServiceOptions = {}) {}

  suggestions(roomId: string) { return discoverVerificationChecks(this.scope({ roomId, rootTaskId: "draft:suggestions" }, true).policy); }
  getPlan(id: string): VerificationPlan | null {
    const row = this.db.query<StoredPlan, [string]>("SELECT plan_json FROM verification_plans WHERE id=?").get(id);
    return row ? JSON.parse(row.plan_json) : null;
  }
  prepare(input: PrepareVerificationInput): VerificationPlan {
    if(input.rootTaskId)assertTaskWorkflowCompatible(this.db,input.rootTaskId);
    this.validateInput(input);
    const requestHash = hashToolInput(input);
    const prior = this.db.query<StoredPlan & { request_hash: string }, [string,string]>("SELECT plan_json,request_hash FROM verification_plans WHERE room_id=? AND request_id=?").get(input.roomId,input.requestId);
    if (prior) { if (prior.request_hash !== requestHash) throw new Error("verification_request_conflict"); return JSON.parse(prior.plan_json); }
    const target = { roomId: input.roomId, rootTaskId: input.rootTaskId ?? `draft:${input.requestId}`, ...(input.workPackageId ? { workPackageId: input.workPackageId } : {}) };
    const { policy, workspace } = this.scope(target, true);
    const assertionPaths=input.checks.flatMap(check=>check.kind==="file"||check.kind==="json_schema"?[check.path]:[]);
    const baselineSnapshot = captureVerificationSnapshot(policy,[...input.artifactPaths,...assertionPaths]);
    // Command definitions can live outside the output scope. Freeze existing
    // repository tests/configuration independently of selected artifact paths.
    const definitions=input.checks.some(check=>check.kind==="command")?captureVerificationSnapshot(policy,["."]):baselineSnapshot;
    const commandSources=input.checks.flatMap(check=>check.kind!=="command"?[]:check.command.argv
      .filter(arg=>!arg.startsWith("-")&&/\.(?:[cm]?[jt]sx?|py|sh|bash|rb|pl|ps1)$/u.test(arg))
      .map(arg=>verificationPath(`${check.command.cwd ?? "."}/${arg}`)));
    const protectedPaths = [...new Set([...input.protectedPaths,...commandSources, ...input.checks.flatMap(check=>check.definitionPaths ?? []), ...protectedVerificationPaths(definitions)])].map(verificationPath).sort();
    const protectedSnapshot = captureVerificationSnapshot(policy,protectedPaths);
    const latest = this.latestPlan(target);
    const body = { target, workspaceIdentity: workspace.identityHash, version: (latest?.version ?? 0)+1, checks: structuredClone(input.checks), artifactPaths: baselineSnapshot.paths,
      protectedPaths, baselineSnapshot, protectedSnapshot, manualJudgment: input.manualJudgment ?? [], source: input.source ?? "user", risk: "local_checks" as const };
    const plan: VerificationPlan = { ...body, id:crypto.randomUUID(), hash:hashToolInput(body), approvalStatus:"proposed",approvedAt:null,createdAt:new Date().toISOString() };
    this.insertPlan(plan,input.requestId,requestHash);
    return plan;
  }
  approve(planId: string,requestId: string): VerificationPlan {
    const plan = this.requirePlan(planId);
    assertTaskWorkflowCompatible(this.db,plan.target.rootTaskId);
    const fingerprint=hashToolInput({kind:"approve",planId});
    const previous=this.request(plan.target.roomId,requestId,fingerprint); if(previous)return previous as VerificationPlan;
    const {policy,workspace}=this.scope(plan.target,true);
    if(workspace.identityHash!==plan.workspaceIdentity)throw new Error("validation_contract_changed");
    if(captureVerificationSnapshot(policy,plan.protectedPaths).hash!==plan.protectedSnapshot.hash)throw new Error("validation_contract_changed");
    if(this.latestPlan(plan.target)?.id!==plan.id)throw new Error("verification_plan_superseded");
    const approved={...plan,approvalStatus:"approved" as const,approvedAt:plan.approvedAt ?? new Date().toISOString()};
    this.db.transaction(()=>{this.db.query("UPDATE verification_plans SET plan_json=? WHERE id=?").run(JSON.stringify(approved),planId);this.saveRequest(plan.target.roomId,requestId,fingerprint,approved);})();
    return approved;
  }
  bind(planId:string,target:VerificationTarget):VerificationPlan {
    assertTaskWorkflowCompatible(this.db,target.rootTaskId);
    const source=this.requirePlan(planId);this.scope(target);
    if(source.target.roomId!==target.roomId)throw new Error("verification_target_mismatch");
    if(source.approvalStatus!=="approved")throw new Error("verification_plan_approval_required");
    if(this.latestPlan(source.target)?.id!==source.id)throw new Error("verification_plan_superseded");
    const requestId=`bind:${hashToolInput({planId,target})}`;
    const duplicate=this.db.query<StoredPlan,[string,string]>("SELECT plan_json FROM verification_plans WHERE room_id=? AND request_id=?").get(target.roomId,requestId);
    if(duplicate)return JSON.parse(duplicate.plan_json);
    const {policy,workspace}=this.scope(target);
    if(workspace.identityHash!==source.workspaceIdentity)throw new Error("validation_contract_changed");
    if(captureVerificationSnapshot(policy,source.protectedPaths).hash!==source.protectedSnapshot.hash)throw new Error("validation_contract_changed");
    const plan:VerificationPlan={...source,id:crypto.randomUUID(),target,version:(this.latestPlan(target)?.version ?? 0)+1,sourcePlanId:source.id,createdAt:new Date().toISOString()};
    plan.hash=hashToolInput({...plan,id:undefined,hash:undefined,createdAt:undefined});
    this.insertPlan(plan,requestId,hashToolInput({planId,target}));return plan;
  }
  view(target:VerificationTarget):VerificationView {
    const plan=this.latestPlan(target);
    if(!plan)return this.withPackageEvidence({target,plan:null,run:null,verificationStatus:"not_requested",outcome:"completed_unverified",acceptedUnverified:false,gatePassed:true});
    let scope: ReturnType<VerificationService['scope']>;
    try { scope=this.scope(target,true,true); }
    catch(error) {
      if(!(error instanceof Error)||!['verification_room_unavailable','verification_workspace_unavailable'].includes(error.message))throw error;
      const run=this.latestRun(plan.id);
      // Retain evidence history without allowing unavailable evidence to pass a gate.
      return this.withPackageEvidence({target,plan,run:run?{...run,status:"invalidated",outcome:"completed_unverified",reason:error.message}:null,verificationStatus:"invalidated",outcome:"completed_unverified",acceptedUnverified:false,gatePassed:false});
    }
    const {policy,workspace}=scope;
    let run=this.latestRun(plan.id);
    if(run?.status==="passed" && run.mode==="final"){
      let reason:string|undefined;
      try{
        if(workspace.identityHash!==plan.workspaceIdentity||captureVerificationSnapshot(policy,plan.protectedPaths).hash!==plan.protectedSnapshot.hash)reason="validation_contract_changed";
        else if(captureVerificationSnapshot(policy,plan.artifactPaths).hash!==run.snapshot.hash)reason="verification_artifact_changed";
      }catch{reason="verification_snapshot_unavailable";}
      if(reason){run={...run,status:"invalidated",outcome:"completed_unverified",reason};this.persistRun(run,"verification.invalidated");}
    }
    let acceptedUnverified=false;
    const acceptance=this.db.query<StoredAcceptance,[string]>("SELECT id,snapshot_hash FROM verification_acceptance WHERE plan_id=? ORDER BY rowid DESC LIMIT 1").get(plan.id);
    if(acceptance)try{acceptedUnverified=workspace.identityHash===plan.workspaceIdentity&&captureVerificationSnapshot(policy,plan.artifactPaths).hash===acceptance.snapshot_hash;}catch{/* unavailable is never accepted */}
    const final=run?.mode==="final"?run:null;
    const view:VerificationView={target,plan,run,verificationStatus:final?.status ?? "pending",outcome:final?.outcome ?? "completed_unverified",acceptedUnverified,
      gatePassed:final?.status==="passed" || acceptedUnverified};
    return this.withPackageEvidence(view,acceptance);
  }
  private withPackageEvidence(view:VerificationView,acceptance:StoredAcceptance|null=null):VerificationView {
    const {target}=view;
    const children:Array<[string,string|null]>=[];
    if(!target.workPackageId){
      const rows=this.db.query<{package_id:string},[string,string]>("SELECT DISTINCT package_id FROM verification_plans WHERE room_id=? AND root_task_id=? AND package_id!='' ORDER BY package_id").all(target.roomId,target.rootTaskId);
      const active=this.db.query<{task_id:string|null},[string]>("SELECT task_id FROM room_commands WHERE id=? AND EXISTS (SELECT 1 FROM adaptive_workflows WHERE root_task_id=room_commands.id)").get(target.rootTaskId);
      const unverified:string[]=[];
      for(const row of rows){
        const owner=this.db.query<{task_id:string},[string]>("SELECT task_id FROM work_packages WHERE id=?").get(row.package_id);
        // Earlier adaptive attempts remain auditable facts. Only the current
        // child owns the completion gate; its predecessors cannot block it.
        if(active&&owner&&owner.task_id!==active.task_id)continue;
        try{const child=this.view({...target,workPackageId:row.package_id});children.push([row.package_id,child.evidenceRevision??null]);if(child.outcome!=="verified_success")unverified.push(row.package_id);if(!child.gatePassed)view.gatePassed=false;}
        catch{children.push([row.package_id,null]);unverified.push(row.package_id);view.gatePassed=false;}
      }
      if(unverified.length){view.unverifiedPackageIds=unverified;if(view.outcome==="verified_success")view.outcome="completed_unverified";}
    }
    // A new explicit acceptance acknowledges a specific snapshot, even when
    // its preceding verification run and acceptedUnverified flag are unchanged.
    view.evidenceRevision=hashToolInput({planId:view.plan?.id??null,runId:view.run?.id??null,status:view.verificationStatus,snapshot:view.run?.snapshot.hash??null,acceptance,acceptedUnverified:view.acceptedUnverified,gatePassed:view.gatePassed,children});
    return view;
  }
  async verify(target:VerificationTarget,options:VerifyOptions={}):Promise<VerificationView>{
    assertTaskWorkflowCompatible(this.db,target.rootTaskId);
    const current=this.view(target);if(!current.plan)return current;
    this.scope(target,true,true);
    const plan=current.plan;
    if(!options.baseline && plan.approvalStatus!=="approved")throw new Error("verification_plan_approval_required");
    const requestId=options.requestId ?? `${options.baseline?"baseline":"execution"}:${options.runId ?? "initial"}`;
    this.checkRequestId(requestId);
    const existing=this.db.query<StoredRun,[string,string]>("SELECT run_json FROM verification_runs WHERE plan_id=? AND request_id=?").get(plan.id,requestId);
    if(existing){const run=JSON.parse(existing.run_json) as VerificationRun;
      if(run.mode!==(options.baseline?"baseline":"final")||run.executionRunId!==options.runId)throw new Error("verification_request_conflict");
      return this.active.get(run.id)?.promise ?? this.view(target);}
    if(this.activeFor(target))throw new Error("verification_already_running");
    if(current.run?.status==="pending"&&current.run.pendingApprovals.length)throw new Error("verification_approval_pending");
    const {room,policy}=this.scope(target,true);
    const snapshot=captureVerificationSnapshot(policy,plan.artifactPaths);
    if(options.baseline && snapshot.hash!==plan.baselineSnapshot.hash)throw new Error("verification_baseline_changed");
    const agentId=options.agentId ?? room.primaryAgentId;
    if(!room.agents.some(member=>member.agentId===agentId&&member.executionEligible))throw new Error("verification_member_unavailable");
    const run:VerificationRun={id:crypto.randomUUID(),target,planId:plan.id,planVersion:plan.version,planHash:plan.hash,requestId,
      ...(options.runId?{executionRunId:options.runId}:{}),agentId,mode:options.baseline?"baseline":"final",status:"pending",outcome:"completed_unverified",snapshot,evidence:[],pendingApprovals:[],startedAt:new Date().toISOString(),finishedAt:null};
    this.db.query("INSERT INTO verification_runs(id,plan_id,room_id,root_task_id,package_id,request_id,mode,status,run_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(run.id,plan.id,target.roomId,target.rootTaskId,target.workPackageId ?? "",requestId,run.mode,run.status,JSON.stringify(run),run.startedAt);
    return this.launch(run,options);
  }
  async baseline(planId:string,requestId:string){const plan=this.requirePlan(planId);return this.verify(plan.target,{baseline:true,requestId});}
  async decide(approvalId:string,input:{decision:"allow_once"|"deny";requestId:string}):Promise<VerificationView>{
    this.checkRequestId(input.requestId);
    const approval=this.approvals.getRequest(approvalId);if(!approval)throw new Error("verification_approval_not_found");
    const run=approval.taskId.startsWith("verification:")?this.getRun(approval.taskId.slice("verification:".length)):null;
    if(!run||approval.sessionId!==run.target.roomId)throw new Error("verification_approval_not_found");
    assertTaskWorkflowCompatible(this.db,run.target.rootTaskId);
    const fingerprint=hashToolInput({kind:"decide",approvalId,decision:input.decision});
    if(this.request(run.target.roomId,input.requestId,fingerprint)){this.scope(run.target,true,true);return this.active.get(run.id)?.promise ?? this.view(run.target);}
    this.scope(run.target,true);
    if(!["pending","running"].includes(run.status))throw new Error("verification_run_not_pending");
    if(!run.pendingApprovals.some(item=>item.id===approvalId))throw new Error("verification_approval_not_found");
    const plan=this.requirePlan(run.planId);
    if(this.latestPlan(run.target)?.id!==plan.id)throw new Error("verification_plan_superseded");
    this.approvals.decide(approvalId,{clientDecisionKey:`verification:${input.requestId}`,decision:input.decision});
    this.saveRequest(run.target.roomId,input.requestId,fingerprint,{runId:run.id});
    return this.launch(run,{});
  }
  async cancel(target:VerificationTarget,requestId=`cancel:${crypto.randomUUID()}`):Promise<VerificationView>{
    this.checkRequestId(requestId);
    const plan=this.latestPlan(target);if(!plan)return this.view(target);
    this.scope(target,true,true);
    const fingerprint=hashToolInput({kind:"cancel",target});
    const previous=this.request(target.roomId,requestId,fingerprint) as {runId?:string}|null;
    if(previous){if(previous.runId)await this.active.get(previous.runId)?.promise;return this.view(target);}
    this.saveRequest(target.roomId,requestId,fingerprint,{runId:this.latestRun(plan.id)?.id});
    const active=this.activeFor(target);if(active){active.controller.abort(new Error("verification_cancelled"));await active.promise;}
    const run=this.latestRun(plan.id);
    if(run&&["running","pending"].includes(run.status)){this.approvals.expireForTask(`verification:${run.id}`);this.persistRun({...run,status:"inconclusive",outcome:"cancelled",reason:"verification_cancelled",pendingApprovals:[],finishedAt:new Date().toISOString()},"verification.finished");}
    return this.view(target);
  }
  acceptUnverified(target:VerificationTarget,requestId:string):VerificationView{
    assertTaskWorkflowCompatible(this.db,target.rootTaskId);
    const current=this.view(target);if(!current.plan)throw new Error("verification_plan_not_found");
    this.scope(target,true,true);
    if(this.activeFor(target)||current.run?.status==="running")throw new Error("verification_already_running");
    const fingerprint=hashToolInput({kind:"accept",target,planId:current.plan.id});
    if(this.request(target.roomId,requestId,fingerprint))return this.view(target);
    const {policy}=this.scope(target,true),snapshot=captureVerificationSnapshot(policy,current.plan.artifactPaths);
    if(current.run?.status==="pending"){
      this.approvals.expireForTask(`verification:${current.run.id}`);
      this.persistRun({...current.run,status:"inconclusive",outcome:"completed_unverified",reason:"accepted_unverified",pendingApprovals:[],finishedAt:new Date().toISOString()},"verification.finished");
    }
    this.db.transaction(()=>{
      this.db.query("INSERT INTO verification_acceptance(id,room_id,root_task_id,package_id,plan_id,run_id,snapshot_hash,request_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(crypto.randomUUID(),target.roomId,target.rootTaskId,target.workPackageId ?? "",current.plan!.id,current.run?.id ?? null,snapshot.hash,requestId,new Date().toISOString());
      this.saveRequest(target.roomId,requestId,fingerprint,{accepted:true});
      this.events.appendInTransaction({eventId:`verification-accept:${target.roomId}:${requestId}`,sessionId:target.roomId,taskId:target.rootTaskId,type:"verification.accepted_unverified",payload:{...target,planId:current.plan!.id,snapshotHash:snapshot.hash}});
    })();
    const view=this.view(target);void this.options.onChanged?.(view);return view;
  }
  recoverInterrupted():number{
    const rows=this.db.query<StoredRun,[]>("SELECT run_json FROM verification_runs WHERE status IN ('running','pending')").all();
    for(const row of rows){const run=JSON.parse(row.run_json) as VerificationRun;this.approvals.expireForTask(`verification:${run.id}`);
      this.persistRun({...run,status:"inconclusive",outcome:"blocked",reason:"verification_interrupted_requires_rerun",pendingApprovals:[],finishedAt:new Date().toISOString()},"verification.finished");}
    return rows.length;
  }
  async shutdown():Promise<void>{await Promise.all([...this.active.values()].map(async active=>{active.controller.abort(new Error("verification_interrupted"));await active.promise;}));}
  async cancelRoot(roomId:string,rootTaskId:string):Promise<void>{
    const rows=this.db.query<StoredPlan,[string,string]>("SELECT plan_json FROM verification_plans WHERE room_id=? AND root_task_id=?").all(roomId,rootTaskId);
    const targets=new Map(rows.map(row=>{const target=(JSON.parse(row.plan_json) as VerificationPlan).target;return [target.workPackageId ?? "",target] as const;}));
    await Promise.all([...targets.values()].map(target=>this.cancel(target)));
  }
  readEvidenceOutput(evidenceId:string,roomId:string,stream:"stdout"|"stderr",offset=0){
    const row=this.db.query<{evidence_json:string;room_id:string},[string]>("SELECT e.evidence_json,r.room_id FROM verification_evidence e JOIN verification_runs r ON r.id=e.run_id WHERE e.id=?").get(evidenceId);
    if(!row||row.room_id!==roomId)throw new Error("verification_evidence_not_found");
    const {workspace}=this.scope({roomId,rootTaskId:"draft:output"},true);
    const evidence=JSON.parse(row.evidence_json) as CheckEvidence,ref=stream==="stdout"?evidence.stdoutRef:evidence.stderrRef;
    if(!ref)throw new Error("verification_output_unavailable");
    return this.outputs.read({sessionId:roomId,workspaceIdentity:workspace.identityHash},ref,offset,16*1024);
  }

  private async launch(run:VerificationRun,options:VerifyOptions):Promise<VerificationView>{
    const prior=this.active.get(run.id);if(prior)return prior.promise;
    const controller=new AbortController();const abort=()=>controller.abort(options.signal?.reason);options.signal?.addEventListener("abort",abort,{once:true});if(options.signal?.aborted)abort();
    const promise=Promise.resolve().then(()=>this.execute(run,{...options,signal:controller.signal})).finally(()=>{this.active.delete(run.id);options.signal?.removeEventListener("abort",abort);});
    this.active.set(run.id,{controller,promise});return promise;
  }
  private async execute(run:VerificationRun,options:VerifyOptions):Promise<VerificationView>{
    const plan=this.requirePlan(run.planId),{room,workspace,policy}=this.scope(run.target,true);
    const controller=options.signal!;let ownedLease:string|undefined;let renewal:ReturnType<typeof setInterval>|undefined;
    try{
      if(options.leaseId){const lease=this.leases.get(options.leaseId);if(!lease||lease.workspaceId!==workspace.id||lease.mode!=="write"||lease.expiresAt<=new Date().toISOString())throw new Error("verification_write_lease_required");}
      else{const lease=await this.leases.acquireQueued(workspace.id,`verification:${run.id}`,{signal:controller});ownedLease=lease.id;
        renewal=setInterval(()=>{try{this.leases.renew(lease.id,new Date(Date.now()+30*60_000).toISOString());}catch{this.active.get(run.id)?.controller.abort(new Error("workspace_lease_lost"));}},60_000);}
      controller.throwIfAborted();
      if(this.latestPlan(run.target)?.id!==plan.id)throw new Error("verification_plan_superseded");
      if(workspace.identityHash!==plan.workspaceIdentity)throw new Error("validation_contract_changed");
      if(captureVerificationSnapshot(policy,plan.protectedPaths).hash!==plan.protectedSnapshot.hash)throw new Error("validation_contract_changed");
      if(captureVerificationSnapshot(policy,plan.artifactPaths).hash!==run.snapshot.hash)throw new Error("verification_artifact_changed");
      run.status="running";run.reason=undefined;this.persistRun(run,"verification.started");
      const registry=new ToolRegistry(createNativeBuiltinTools(policy,this.outputs,{sessionId:room.id,workspaceIdentity:workspace.identityHash},this.options.commandRunner));
      const executor=new ToolExecutor(this.db,registry,this.approvals,undefined,this.executionEvents);
      for(const check of plan.checks){
        controller.throwIfAborted();if(run.evidence.some(item=>item.checkId===check.id))continue;
        const evidence=this.newEvidence(run,plan,check);
        if(check.kind==="command"){
          const current=this.scope(run.target,true).room;
          if(!current.agents.some(member=>member.agentId===run.agentId&&member.executionEligible))throw new Error("verification_member_unavailable");
          const definition=registry.resolve("run_command",3);
          const context:ToolContext={callId:`verification:${run.id}:${check.id}`,sessionId:room.id,taskId:`verification:${run.id}`,turnId:run.id,stepId:check.id,agentId:run.agentId,workspaceId:workspace.id,mode:"single_agent",phase:"executing",signal:controller};
          const permission=evaluatePermission({action:"shell.execute",resource:definition.name,risk:definition.risk,mode:context.mode,phase:context.phase,capabilityAllowed:true,policyVersion:current.approvalPolicy.version,approvalMode:current.approvalPolicy.mode,rules:[]});
          let record=await executor.invoke({stableKey:context.callId,name:definition.name,generation:definition.generation,input:check.command,workspaceIdentity:workspace.identityHash,policyVersion:current.approvalPolicy.version},context,permission);
          evidence.operationId=record.id;evidence.command={executable:check.command.executable,argv:check.command.argv,cwd:check.command.cwd ?? "."};
          if(record.status==="awaiting_approval"){
            const approval=record.approval ?? this.approvals.getRequestForSubject(record.id);if(!approval)throw new Error("verification_approval_missing");
            evidence.approvalId=approval.id;
            if(approval.status==="pending"){
              run.pendingApprovals=[{id:approval.id,checkId:check.id,operationId:record.id,command:check.command}];run.status="pending";run.reason="verification_approval_required";this.persistRun(run,"verification.approval_required");return this.view(run.target);
            }
            if(approval.status==="allowed")record=await executor.resumeApproved(record.id,context);
            else{record={...record,status:"failed",error:"verification_permission_denied"};}
          }
          run.pendingApprovals=[];
          this.commandEvidence(evidence,record,check,plan,workspace.identityHash,policy);
        }else this.assertionEvidence(evidence,check,policy);
        evidence.finishedAt=new Date().toISOString();evidence.durationMs=Date.parse(evidence.finishedAt)-Date.parse(evidence.startedAt);
        if(evidence.status!=="passed")evidence.failureSignature=hashToolInput({reason:evidence.reason,exitCode:evidence.exitCode,diagnostics:stableVerificationDiagnostic(evidence.diagnostics),artifact:run.snapshot.hash,check:check.id});
        this.db.query("INSERT INTO verification_evidence(id,run_id,check_id,evidence_json) VALUES(?,?,?,?)").run(evidence.id,run.id,check.id,JSON.stringify(evidence));
        run.evidence.push(evidence);this.persistRun(run,"verification.check_finished");
      }
      controller.throwIfAborted();
      if(captureVerificationSnapshot(policy,plan.protectedPaths).hash!==plan.protectedSnapshot.hash)throw new Error("validation_contract_changed");
      if(captureVerificationSnapshot(policy,plan.artifactPaths).hash!==run.snapshot.hash)throw new Error("verification_artifact_changed");
      const conclusion=verificationConclusion(plan.checks,run.evidence,plan.manualJudgment);
      Object.assign(run,conclusion,{finishedAt:new Date().toISOString()});
      if(conclusion.status!=="passed")run.failureSignature=hashToolInput({reason:run.reason,artifact:run.snapshot.hash,checks:run.evidence.filter(item=>item.status!=="passed").map(item=>item.failureSignature)});
      if(run.mode==="baseline"){const latest=this.requirePlan(plan.id);this.db.query("UPDATE verification_plans SET plan_json=? WHERE id=?").run(JSON.stringify({...latest,baselineRunId:run.id}),plan.id);}
      this.persistRun(run,"verification.finished");
    }catch(error){
      const reason=controller.aborted?(controller.reason instanceof Error&&controller.reason.message==="verification_cancelled"?"verification_cancelled":"verification_interrupted_requires_rerun"):error instanceof Error?error.message:String(error);
      run.status=["validation_contract_changed","verification_artifact_changed"].includes(reason)?"invalidated":"inconclusive";
      run.outcome=controller.aborted?"cancelled":"blocked";run.reason=reason;run.pendingApprovals=[];run.finishedAt=new Date().toISOString();
      run.failureSignature=hashToolInput({reason,artifact:run.snapshot.hash});this.approvals.expireForTask(`verification:${run.id}`);this.persistRun(run,"verification.finished");
    }finally{if(renewal)clearInterval(renewal);if(ownedLease)this.leases.release(ownedLease);}
    const view=this.view(run.target);await this.options.onChanged?.(view);return view;
  }
  private newEvidence(run:VerificationRun,plan:VerificationPlan,check:VerificationCheck):CheckEvidence{
    const baseline=plan.baselineRunId?this.getRun(plan.baselineRunId):null;
    return {id:`${run.id}:${check.id}`,checkId:check.id,planVersion:plan.version,planHash:plan.hash,runId:run.id,executionRunId:run.executionRunId,
      artifactSnapshotHash:run.snapshot.hash,implementationHash:hashToolInput({check,protected:plan.protectedSnapshot.hash}),status:"inconclusive",reason:"verification_pending",
      startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),durationMs:0,runnerVersion:RUNNER_VERSION,environment:ENVIRONMENT,
      changedPaths:changedVerificationPaths(plan.baselineSnapshot,run.snapshot),...(baseline?.evidence.find(item=>item.checkId===check.id)?{baselineStatus:baseline.evidence.find(item=>item.checkId===check.id)!.status}:{})};
  }
  private assertionEvidence(evidence:CheckEvidence,check:Exclude<VerificationCheck,{kind:"command"}>,policy:WorkspacePathPolicy){
    try{
      const read=policy.readBytes(check.path,2*1024*1024);
      if(read.truncated&&(check.kind==="json_schema"||check.contains!==undefined))throw new Error("verification_assertion_file_too_large");
      const text=new TextDecoder().decode(read.bytes);
      if(check.kind==="file")evidence.assertions=[{name:"file_exists",passed:true},...(check.minBytes===undefined?[]:[{name:"minimum_bytes",passed:read.byteSize>=check.minBytes}]),...(check.contains===undefined?[]:[{name:"required_content",passed:text.includes(check.contains)}]),...(check.expectedSha256===undefined?[]:[{name:"content_hash",passed:read.sha256===check.expectedSha256}])];
      else{let value:unknown;try{value=JSON.parse(text);}catch{evidence.status="failed";evidence.reason="verification_invalid_json";return;}
        let validate:ReturnType<Ajv["compile"]>;
        try{validate=this.schemas.compile(check.schema);}catch(error){evidence.status="inconclusive";evidence.reason="verification_schema_unsupported";evidence.diagnostics=redactDiagnostic(error);return;}
        if("$async" in validate && validate.$async){evidence.status="inconclusive";evidence.reason="verification_schema_unsupported";evidence.diagnostics="Asynchronous JSON Schema requires an unsupported asynchronous validator.";return;}
        const passed=validate(value);evidence.assertions=[{name:"json_schema",passed:passed===true}];if(!passed)evidence.diagnostics=this.schemas.errorsText(validate.errors).slice(0,4_000);
      }
      evidence.status=evidence.assertions.every(item=>item.passed)?"passed":"failed";evidence.reason=evidence.status==="passed"?"structured_assertions_passed":"verification_assertion_failed";
    }catch(error){evidence.status="failed";evidence.reason="verification_file_unavailable";evidence.diagnostics=redactDiagnostic(error);}
  }
  private commandEvidence(evidence:CheckEvidence,record:ToolExecutionRecord,check:Extract<VerificationCheck,{kind:"command"}>,plan:VerificationPlan,workspaceIdentity:string,policy:WorkspacePathPolicy){
    const row=this.db.query<{canonical_json:string|null;storage_key:string|null},[string]>("SELECT canonical_json,storage_key FROM tool_outputs WHERE tool_call_id=?").get(record.id);
    let raw:Record<string,unknown>|undefined;
    try{const serialized=row?.canonical_json ?? (row?.storage_key?this.readOutputAll({sessionId:plan.target.roomId,workspaceIdentity},row.storage_key):undefined);if(serialized)raw=JSON.parse(serialized);}catch{/* malformed/missing evidence is inconclusive */}
    const result=(raw?.result ?? raw) as StructuredCommandResult|undefined;
    if(result&&typeof result.exitCode==="number"){
      evidence.exitCode=result.exitCode;evidence.signal=result.signal;evidence.timedOut=result.timedOut;evidence.stdoutRef=result.fullOutputRefs?.stdout;evidence.stderrRef=result.fullOutputRefs?.stderr;
      evidence.command={executable:result.executable,argv:result.argv,cwd:result.cwd};evidence.durationMs=result.durationMs;
      evidence.diagnostics=redactDiagnostic(`${result.stderrPreview ?? result.stderr}\n${result.stdoutPreview ?? result.stdout}`);
      if(record.status==="succeeded"){
        let output:string|undefined;
        // A workspace file may predate this operation or be written by the
        // worker. Until a runner-owned report adapter exists it is not evidence.
        if(check.reportPath){evidence.reason="verification_report_provenance_unavailable";return;}
        else if(result.stdoutTruncated||result.stderrTruncated){
          if(!result.fullOutputRefs){evidence.reason="verification_report_truncated";return;}
          try{output=[result.fullOutputRefs.stdout,result.fullOutputRefs.stderr].map(ref=>this.readOutputAll({sessionId:plan.target.roomId,workspaceIdentity},ref)).join("\n");}catch(error){evidence.reason="verification_report_unavailable";evidence.diagnostics=redactDiagnostic(error);return;}
        }
        Object.assign(evidence,parseVerificationCommand(check,result,output));
        if(evidence.status==="passed"&&check.category==="test"&&check.origin==="repository"&&!plan.protectedSnapshot.files.some(file=>/\.(test|spec)\.|(^|\/)(__tests__|tests?|fixtures?)\//u.test(file.path))){evidence.status="inconclusive";evidence.reason="independent_acceptance_required";}
        return;
      }
    }
    evidence.status="inconclusive";evidence.reason=record.error==="verification_permission_denied"?"verification_permission_denied":record.status==="timed_out"?"verification_timeout":record.status==="cancelled"?"verification_cancelled":record.status==="outcome_unknown"?"verification_tool_outcome_unknown":/shell_(?:sandbox|executable)_unavailable|shell_spawn_failed/u.test(record.error ?? "")?"verification_environment_unavailable":"verification_execution_unavailable";
    evidence.diagnostics=redactDiagnostic(record.error ?? record.output?.preview ?? "No canonical command result");
  }
  private readOutputAll(scope:{sessionId:string;workspaceIdentity:string},ref:string){let offset=0,text="";while(true){const part=this.outputs.read(scope,ref,offset,32768);if(part.byteSize>2*1024*1024)throw new Error("verification_report_too_large");text+=part.text;if(!part.truncated)return text;offset=part.nextOffset;}}
  private scope(target:VerificationTarget,allowDraft=false,allowHistorical=false){
    if(!target||typeof target.roomId!=="string"||typeof target.rootTaskId!=="string"||!target.rootTaskId)throw new Error("verification_target_invalid");
    const room=this.sessions.get(target.roomId);if(!room||room.archived)throw new Error("verification_room_unavailable");
    if(room.kind!=="cowork"||!room.workspaceId)throw new Error("verification_work_room_required");
    const workspace=this.workspaces.get(room.workspaceId);if(!workspace||workspace.archived)throw new Error("verification_workspace_unavailable");
    if(!(allowDraft&&target.rootTaskId.startsWith("draft:"))){
      const command=this.db.query<{room_id:string;task_id:string|null},[string]>("SELECT room_id,task_id FROM room_commands WHERE id=? AND status!='revoked'").get(target.rootTaskId);
      const task=this.db.query<{session_id:string},[string]>("SELECT session_id FROM multi_tasks WHERE id=?").get(target.rootTaskId);
      const run=this.db.query<{session_id:string},[string]>("SELECT session_id FROM agent_runs WHERE id=?").get(target.rootTaskId);
      if((command?.room_id ?? task?.session_id ?? run?.session_id)!==room.id)throw new Error("verification_target_not_found");
      if(target.workPackageId){
        const item=this.db.query<{task_id:string},[string]>("SELECT task_id FROM work_packages WHERE id=?").get(target.workPackageId);
        const historical=item&&this.db.query("SELECT id FROM adaptive_attempts WHERE root_task_id=? AND json_extract(attempt_json,'$.child.kind')='team' AND json_extract(attempt_json,'$.child.id')=?").get(target.rootTaskId,item.task_id);
        if(!item||item.task_id!==(command?.task_id ?? target.rootTaskId)&&!historical)throw new Error("verification_package_not_found");
        if(item.task_id!==(command?.task_id ?? target.rootTaskId)&&!allowHistorical)throw new Error("verification_target_retired");
      }
    }
    let policy:WorkspacePathPolicy;
    try { policy=new WorkspacePathPolicy(workspace.canonicalPath); }
    catch(error) {
      if(['ENOENT','ENOTDIR','EACCES','EPERM','ELOOP'].includes((error as NodeJS.ErrnoException).code ?? ''))throw new Error("verification_workspace_unavailable");
      throw error;
    }
    return {room,workspace,policy};
  }
  private latestPlan(target:VerificationTarget){const row=this.db.query<StoredPlan,[string,string,string]>("SELECT plan_json FROM verification_plans WHERE room_id=? AND root_task_id=? AND package_id=? ORDER BY version DESC LIMIT 1").get(target.roomId,target.rootTaskId,target.workPackageId ?? "");return row?JSON.parse(row.plan_json) as VerificationPlan:null;}
  private latestRun(planId:string){const row=this.db.query<StoredRun,[string]>("SELECT run_json FROM verification_runs WHERE plan_id=? ORDER BY CASE mode WHEN 'final' THEN 0 ELSE 1 END,rowid DESC LIMIT 1").get(planId);return row?JSON.parse(row.run_json) as VerificationRun:null;}
  private getRun(id:string){const row=this.db.query<StoredRun,[string]>("SELECT run_json FROM verification_runs WHERE id=?").get(id);return row?JSON.parse(row.run_json) as VerificationRun:null;}
  private requirePlan(id:string){const plan=this.getPlan(id);if(!plan)throw new Error("verification_plan_not_found");return plan;}
  private insertPlan(plan:VerificationPlan,requestId:string,requestHash:string){this.db.query("INSERT INTO verification_plans(id,room_id,root_task_id,package_id,version,request_id,request_hash,plan_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(plan.id,plan.target.roomId,plan.target.rootTaskId,plan.target.workPackageId ?? "",plan.version,requestId,requestHash,JSON.stringify(plan),plan.createdAt);}
  private persistRun(run:VerificationRun,type:string){this.db.transaction(()=>{this.db.query("UPDATE verification_runs SET run_json=?,status=? WHERE id=?").run(JSON.stringify(run),run.status,run.id);this.events.appendInTransaction({eventId:`${type}:${run.id}:${crypto.randomUUID()}`,sessionId:run.target.roomId,taskId:run.target.rootTaskId,type,payload:{...run.target,verificationRunId:run.id,executionRunId:run.executionRunId,planId:run.planId,planHash:run.planHash,snapshotHash:run.snapshot.hash,status:run.status,outcome:run.outcome,reason:run.reason}});})();}
  private activeFor(target:VerificationTarget){return [...this.active].find(([id])=>{const run=this.getRun(id);return run?.target.roomId===target.roomId&&run.target.rootTaskId===target.rootTaskId&&run.target.workPackageId===target.workPackageId;})?.[1];}
  private checkRequestId(id:string){if(typeof id!=="string"||!id.trim()||id.length>300)throw new Error("verification_request_invalid");}
  private request(roomId:string,id:string,fingerprint:string):unknown{this.checkRequestId(id);const row=this.db.query<{request_hash:string;result_json:string},[string,string]>("SELECT request_hash,result_json FROM verification_requests WHERE room_id=? AND request_id=?").get(roomId,id);if(!row)return null;if(row.request_hash!==fingerprint)throw new Error("verification_request_conflict");return JSON.parse(row.result_json);}
  private saveRequest(roomId:string,id:string,fingerprint:string,result:unknown){this.db.query("INSERT INTO verification_requests(room_id,request_id,request_hash,result_json) VALUES(?,?,?,?)").run(roomId,id,fingerprint,JSON.stringify(result));}
  private validateInput(input:PrepareVerificationInput){
    this.checkRequestId(input.requestId);
    if(!Array.isArray(input.checks)||!input.checks.length||input.checks.length>20||!Array.isArray(input.artifactPaths)||!input.artifactPaths.length||input.artifactPaths.length>100||!Array.isArray(input.protectedPaths)||input.protectedPaths.length>4_000)throw new Error("verification_plan_invalid");
    if(new Set(input.checks.map(check=>check.id)).size!==input.checks.length)throw new Error("verification_check_id_duplicate");
    for(const check of input.checks){if(!/^[\w.-]{1,80}$/u.test(check.id)||typeof check.label!=="string"||!check.label||typeof check.required!=="boolean")throw new Error("verification_check_invalid");
      if(check.kind==="command"){if(!check.command||typeof check.command.executable!=="string"||!Array.isArray(check.command.argv)||!check.command.argv.every(value=>typeof value==="string")||!["test","typecheck","build","lint"].includes(check.category)||!["exit_code","bun_test","tap","junit","unsupported"].includes(check.parser))throw new Error("verification_check_invalid");if(check.reportPath)verificationPath(check.reportPath);}
      else if(check.kind==="file"||check.kind==="json_schema"){verificationPath(check.path);if(check.kind==="json_schema"&&(!check.schema||typeof check.schema!=="object"))throw new Error("verification_schema_invalid");}
      else throw new Error("verification_check_invalid");
    }
  }
}
