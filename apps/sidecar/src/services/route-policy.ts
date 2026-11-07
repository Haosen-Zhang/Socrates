import type { Database } from "bun:sqlite";
import { posix } from "node:path";
import { DEFAULT_ROUTE_LIMITS, MAX_AUTOMATIC_OUTPUT_TOKENS, ROUTING_POLICY_VERSION, isRoutingEnabled, resolveRoomCommand, selectRoute, validateCollaborationSettings,
  type FrozenRouteMember, type RoomCommandInput, type RouteDecision, type RoutePreview, type RoutingMember, type TaskFeatures, type VerificationPlan } from "@socrates/core";
import type { SessionStore } from "../store/session-store";
import { WorkspacePathPolicy, isSecretWorkspacePath } from "../workspace/path-policy";
import { hashToolInput } from "../tools/executor";
import { PricingStore } from "./pricing-store";
import { resolveRunProfile } from "./run-profile";
import { modelProtocol } from "../gateway-aisdk";
import { verificationPath } from "./verification-artifacts";
export type { FrozenRouteMember, RouteDecision, RoutePreview } from "@socrates/core";

export type RouteQuoteInput = Omit<RoomCommandInput,"clientRequestId"|"quoteId"> & { routingCandidateId?: string };
export interface RoutePolicyOptions {
  /** Return only availability. A credential is never copied into a routing snapshot. */
  hasCredentials?: (providerId:string,apiKeyRef:string)=>boolean;
  now?: ()=>Date;
}
type ProviderRow={id:string;type:"anthropic"|"openai_compatible";base_url:string;enabled:number;api_key_ref:string};
type WorkspaceRow={canonical_path:string;identity_hash:string;archived:number};
type Metadata={files:string[];manifests:Array<{path:string;sha256:string;name:string;dependencies:string[];scripts:string[]}>;unknowns:string[]};
const OMIT=new Set(["node_modules","vendor","target","dist","build","coverage",".next",".cache",".venv","__pycache__"]);

/** Bounded directory metadata and declared manifests only. Unselected file bodies are never classified. */
function metadata(policy:WorkspacePathPolicy):Metadata{
  const result:Metadata={files:[],manifests:[],unknowns:[]};
  const pending=[{path:".",depth:0}];let directories=0;
  while(pending.length&&directories<100&&result.files.length<800){
    const directory=pending.shift()!;directories++;
    try{
      const listing=policy.listDirectory(directory.path,200);
      if(listing.truncated)result.unknowns.push("workspace_metadata_truncated");
      for(const entry of listing.entries){
        const path=directory.path==="."?entry.name:`${directory.path}/${entry.name}`;
        if(isSecretWorkspacePath(path))continue;
        if(entry.kind==="directory"){
          if(OMIT.has(entry.name))continue;
          if(directory.depth<5)pending.push({path,depth:directory.depth+1});
          else result.unknowns.push("workspace_metadata_depth_limited");
        }else{
          if(result.files.length>=800){result.unknowns.push("workspace_metadata_truncated");break;}
          result.files.push(path);
          if(["package.json","Cargo.toml","pyproject.toml","go.mod"].includes(entry.name)){
            const read=policy.readText(path,128*1024);
            if(read.truncated){result.unknowns.push(`manifest_too_large:${path}`);continue;}
            let name="",dependencies:string[]=[],scripts:string[]=[];
            if(entry.name==="package.json"){
              try{const value=JSON.parse(read.text) as {name?:unknown;dependencies?:Record<string,unknown>;devDependencies?:Record<string,unknown>;peerDependencies?:Record<string,unknown>;scripts?:Record<string,unknown>};
                name=typeof value.name==="string"?value.name:"";
                dependencies=[...new Set([...Object.keys(value.dependencies??{}),...Object.keys(value.devDependencies??{}),...Object.keys(value.peerDependencies??{})])].sort();
                scripts=["test","typecheck","build","lint"].filter(key=>typeof value.scripts?.[key]==="string");
              }catch{result.unknowns.push(`manifest_unreadable:${path}`);}
            }else result.unknowns.push(`dependency_graph_unavailable:${path}`);
            result.manifests.push({path,sha256:read.sha256,name,dependencies,scripts});
          }
        }
      }
    }catch(error){result.unknowns.push(`metadata_unavailable:${directory.path}:${error instanceof Error?error.message:"unknown"}`);}
  }
  if(pending.length)result.unknowns.push("workspace_metadata_truncated");
  result.files.sort();result.manifests.sort((a,b)=>a.path.localeCompare(b.path));result.unknowns=[...new Set(result.unknowns)].sort();return result;
}
const normalizeInput=(input:RouteQuoteInput)=>({roomId:input.roomId,content:input.content,mentions:input.mentions,intent:input.intent,
  attachmentIds:input.attachmentIds??[],workspaceRefIds:input.workspaceRefIds??[],verificationPlanId:input.verificationPlanId??null,
  routingCandidateId:input.routingCandidateId??null,maxOutputTokens:input.maxOutputTokens??MAX_AUTOMATIC_OUTPUT_TOKENS,budget:input.budget??null});
const seal=(preview:Omit<RoutePreview,"bindingHash">|RoutePreview)=>{const {bindingHash:_ignored,...body}=preview as RoutePreview;return hashToolInput(body);};

/** Synchronous local policy. The workflow host is the only owner of execution. */
export class RoutePolicyService {
  constructor(private readonly db:Database,private readonly sessions:SessionStore,private readonly options:RoutePolicyOptions={}) {}
  preview(input:RouteQuoteInput):RoutePreview {
    const room=this.sessions.get(input.roomId);
    if(!room||room.archived)throw new Error("room_not_found");
    if(!input.content?.trim()||!Array.isArray(input.mentions))throw new Error("quote_content_required");
    const resolved=resolveRoomCommand({...room,agentIds:room.agents.map(member=>member.agentId)},input);
    if(!isRoutingEnabled(room,input)||resolved.kind==="discussion")throw new Error("routing_not_enabled_for_command");
    const errors=validateCollaborationSettings({kind:room.kind,workspaceId:room.workspaceId,agentIds:room.agents.map(member=>member.agentId)},room.collaboration);
    if(errors.length)throw new Error(errors[0]);
    const workspace=this.db.query<WorkspaceRow,[string]>("SELECT canonical_path,identity_hash,archived FROM workspaces WHERE id=?").get(room.workspaceId!);
    if(!workspace||workspace.archived)throw new Error("routing_workspace_unavailable");
    const policy=new WorkspacePathPolicy(workspace.canonical_path),meta=metadata(policy);
    const maxOutputTokens=input.maxOutputTokens??MAX_AUTOMATIC_OUTPUT_TOKENS;
    if(!Number.isInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>MAX_AUTOMATIC_OUTPUT_TOKENS)throw new Error("invalid_output_cap");
    const refs=[...new Set([...(input.workspaceRefIds??[]),...input.mentions.flatMap(mention=>mention.type==="file"?[mention.refId]:[])])].map(id=>{
      const row=this.db.query<{workspace_id:string;relative_path:string;kind:string;snapshot_hash:string|null;snapshot_size:number|null},[string]>("SELECT workspace_id,relative_path,kind,snapshot_hash,snapshot_size FROM workspace_refs WHERE id=?").get(id);
      if(!row||row.workspace_id!==room.workspaceId)throw new Error("workspace_reference_out_of_scope");
      verificationPath(row.relative_path);return {id,...row};
    });
    const attachments=(input.attachmentIds??[]).map(id=>{
      const row=this.db.query<{sha256:string;byte_size:number;media_type:string},[string]>("SELECT sha256,byte_size,media_type FROM attachments WHERE id=?").get(id);
      if(!row)throw new Error("attachment_not_found");
      if(!this.db.query("SELECT attachment_id FROM attachment_sources WHERE attachment_id=? AND workspace_id=?").get(id,room.workspaceId))throw new Error("attachment_out_of_scope");
      return {id,...row};
    });
    const selectedPaths=[...new Set(refs.length?refs.flatMap(ref=>ref.kind==="directory"||ref.kind==="folder"?meta.files.filter(path=>path.startsWith(`${ref.relative_path}/`)):[ref.relative_path]):meta.files.filter(path=>input.content.includes(path)))].sort();
    if(selectedPaths.length>100)throw new Error("routing_selected_scope_too_large");
    const selected=selectedPaths.map(path=>{const read=policy.readText(path,128*1024);return {path,sha256:read.sha256,byteSize:read.byteSize,text:read.truncated?"":read.text,truncated:read.truncated};});
    const modulePath=(manifest:string)=>posix.dirname(manifest);
    const moduleOf=(path:string)=>meta.manifests.filter(manifest=>modulePath(manifest.path)==="."||path.startsWith(`${modulePath(manifest.path)}/`)).sort((a,b)=>b.path.length-a.path.length)[0];
    const modulePaths=[...new Set(selectedPaths.flatMap(path=>{const manifest=moduleOf(path);return manifest?[modulePath(manifest.path)]:[];}))].sort();
    const edges:TaskFeatures["dependencyEdges"]=[];
    const addEdge=(from:string,to:string)=>{if(from!==to&&modulePaths.includes(from)&&modulePaths.includes(to)&&!edges.some(edge=>edge.from===from&&edge.to===to))edges.push({from,to});};
    for(const manifest of meta.manifests){for(const name of manifest.dependencies){const target=meta.manifests.find(candidate=>candidate.name===name);if(target)addEdge(modulePath(manifest.path),modulePath(target.path));}}
    for(const file of selected){
      const from=moduleOf(file.path);if(!from)continue;
      for(const match of file.text.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*["'](\.[^"']+)["']/gu)){
        const imported=posix.normalize(posix.join(posix.dirname(file.path),match[1]!));
        const target=moduleOf(imported);if(target)addEdge(modulePath(from.path),modulePath(target.path));
      }
    }
    edges.sort((a,b)=>a.from.localeCompare(b.from)||a.to.localeCompare(b.to));
    let plan:VerificationPlan|null=null;
    if(input.verificationPlanId){
      const row=this.db.query<{plan_json:string},[string]>("SELECT plan_json FROM verification_plans WHERE id=?").get(input.verificationPlanId);
      plan=row?JSON.parse(row.plan_json) as VerificationPlan:null;
      if(!plan||plan.target.roomId!==room.id)throw new Error("verification_target_mismatch");
      if(plan.approvalStatus!=="approved")throw new Error("verification_plan_approval_required");
    }
    const verification={planId:plan?.id??null,planHash:plan?.hash??null,hasChecks:!!plan?.checks.some(check=>check.required&&check.origin!=="worker")};
    const riskReasons=selectedPaths.filter(path=>/(^|\/)(?:migrations?|auth|security|permissions?|deploy|infra)(\/|\.)|(^|\/)(?:Dockerfile|docker-compose\.[^/]+)$/iu.test(path)).map(path=>`sensitive_path:${path}`);
    const routing=room.collaboration.assignment.routing;
    const histories=this.sessions.listMessages(room.id).map(message=>({id:message.id,content:message.content,status:message.status}));
    const publicContextBytes=new TextEncoder().encode(JSON.stringify({request:input.content,history:histories,members:room.agents.map(member=>member.snapshot)})).byteLength;
    const selectedBytes=selected.reduce((sum,file)=>sum+file.byteSize,0);
    const inputTokensEstimate=Math.ceil((publicContextBytes+selectedBytes+attachments.reduce((sum,item)=>sum+item.byte_size,0))/3);
    const unknowns=[...meta.unknowns,...selected.filter(file=>file.truncated).map(file=>`selected_file_truncated:${file.path}`),...(selectedPaths.length?[]:["task_scope_not_explicit"]),"cold_start_without_calibrated_outcomes"];
    const sharedStateCoupled=edges.length>0||meta.unknowns.length>0||selectedPaths.some(path=>/^(package\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock)$/u.test(path));
    const features:TaskFeatures={selectedPaths,fileCount:selectedPaths.length,modulePaths,independentModuleCount:sharedStateCoupled?0:modulePaths.filter(path=>path!==".").length,dependencyEdges:edges,sharedStateCoupled,
      scripts:meta.manifests.filter(manifest=>manifest.scripts.length).map(manifest=>({path:manifest.path,names:manifest.scripts})),risk:riskReasons.length?"sensitive":"ordinary",riskReasons,
      verification:verification.hasChecks&&!plan?.manualJudgment?.length?"machine":plan?"manual":"unconfigured",verificationCheckIds:plan?.checks.filter(check=>check.required).map(check=>check.id)??[],
      requiredCapabilities:{textInput:true,toolCalling:true,imageInput:attachments.some(item=>item.media_type.startsWith("image/")),fileInput:attachments.some(item=>item.media_type==="application/pdf")},
      inputTokensEstimate,contextTokensRequired:inputTokensEstimate+maxOutputTokens+4096,
      scope:!selectedPaths.length?"unknown":modulePaths.filter(path=>path!==".").length>1?"multi_module":"local",evidence:"workspace_metadata",unknowns};
    const now=(this.options.now??(()=>new Date()))().toISOString(),prices=new PricingStore(this.db);
    const members:Record<string,FrozenRouteMember>={},inputMembers:RoutingMember[]=[],profileExclusions:RoutePreview["exclusions"]=[];
    for(const member of room.agents){
      let profile:ReturnType<typeof resolveRunProfile>;
      try{profile=resolveRunProfile(member.agentId,member.snapshot);}catch{profileExclusions.push({agentId:member.agentId,reasonCodes:["run_profile_invalid"]});continue;}
      const provider=this.db.query<ProviderRow,[string]>("SELECT id,type,base_url,enabled,api_key_ref FROM providers WHERE id=?").get(profile.providerId);
      let credentialAvailable=false;
      try{credentialAvailable=!!provider&&!!this.options.hasCredentials?.(provider.id,provider.api_key_ref);}catch{/* unavailable Keychain is an exclusion, never an implicit authorization */}
      const protocol=provider?modelProtocol(provider.type,provider.base_url):"unavailable";
      const price=provider?.enabled?prices.resolveAutomatic({providerConnectionId:provider.id,modelId:profile.modelId,baseUrl:provider.base_url,protocol},now):null;
      inputMembers.push({agentId:member.agentId,providerId:profile.providerId,modelId:profile.modelId,enabled:provider?.enabled===1,credentialAvailable,executionEligible:member.executionEligible,
        egressAllowed:routing.allowedProviderIds===undefined||routing.allowedProviderIds.includes(profile.providerId),capabilities:profile.modelCapabilities,contextWindowTokens:profile.contextWindowTokens,protocol,price});
      if(provider)members[member.agentId]={snapshot:structuredClone(member.snapshot),profile,provider:{id:provider.id,type:provider.type,baseUrl:provider.base_url,protocol},price};
    }
    const lockedAgentIds=[...new Set(input.mentions.flatMap(mention=>mention.type==="agent"?[mention.agentId]:[]))];
    const preset=routing.mode==="manual"?"custom":routing.automaticPolicy==="cost"?"economy":routing.automaticPolicy;
    const limits={...DEFAULT_ROUTE_LIMITS,...routing.limits};
    const customExecutorId=preset==="custom"?(features.risk==="sensitive"?routing.criticalAgentId:features.scope==="multi_module"?routing.complexAgentId:routing.lightweightAgentId):null;
    const managerId=preset==="custom"&&room.collaboration.strategy==="team"&&room.collaboration.discussion.enabled
      ?room.collaboration.discussion.summaryAgentId??room.collaboration.assignment.coordinatorAgentId:room.collaboration.assignment.coordinatorAgentId;
    const selection=selectRoute({preset,strategy:room.collaboration.strategy,primaryAgentId:room.primaryAgentId,managerId,
      customExecutorId,
      discussion:room.collaboration.discussion,
      reviewerId:room.collaboration.planConfirmation.reviewerAgentId,allowedAgentIds:room.collaboration.assignment.callableAgentIds.length?room.collaboration.assignment.callableAgentIds:room.agents.map(member=>member.agentId),
      lockedAgentIds,fallbackAgentIds:routing.fallbackAgentIds??[],members:inputMembers,features,limits,budget:input.budget??null,maxOutputTokens,at:now,selectedCandidateId:input.routingCandidateId});
    const publicMembers=Object.fromEntries(selection.allowedAgentIds.filter(id=>members[id]).map(id=>[id,members[id]!]));
    const metadataHash=hashToolInput({meta,selected:selected.map(({text:_body,...file})=>file),refs,attachments,historyHash:hashToolInput(histories)});
    const preview:Omit<RoutePreview,"bindingHash">={roomId:room.id,inputHash:hashToolInput(normalizeInput(input)),policyVersion:ROUTING_POLICY_VERSION,preset,features,featuresHash:hashToolInput(features),metadataHash,workspaceIdentity:workspace.identity_hash,
      verification,members:publicMembers,allowedAgentIds:selection.allowedAgentIds,allowedProviderIds:routing.allowedProviderIds??[...new Set(Object.values(publicMembers).map(member=>member.provider.id))].sort(),lockedAgentIds,
      fallbackAgentIds:selection.fallbackAgentIds,limits,collaboration:structuredClone(room.collaboration),budget:input.budget??null,candidates:selection.candidates,selectedCandidateId:selection.selectedCandidateId,selected:selection.selected,
      exclusions:[...profileExclusions,...selection.exclusions],reasonCodes:selection.reasonCodes};
    return {...preview,bindingHash:seal(preview)};
  }
  freeze(rootTaskId:string,preview:RoutePreview,quoteId:string|null):RouteDecision {
    if(seal(preview)!==preview.bindingHash)throw new Error("routing_preview_invalid");
    const previous=this.get(rootTaskId);
    if(previous){if(previous.bindingHash!==preview.bindingHash||previous.quoteId!==quoteId)throw new Error("routing_decision_conflict");return previous;}
    if(!preview.selected?.feasible)throw new Error("routing_no_feasible_candidate");
    const command=this.db.query<{room_id:string;input_json:string;status:string},[string]>("SELECT room_id,input_json,status FROM room_commands WHERE id=?").get(rootTaskId);
    if(!command||command.room_id!==preview.roomId||command.status==="revoked")throw new Error("routing_command_not_found");
    const current=this.preview(JSON.parse(command.input_json) as RouteQuoteInput);
    if(current.bindingHash!==preview.bindingHash)throw new Error("routing_preview_stale");
    if(quoteId){
      const quote=this.db.query<{room_id:string;quote_json:string},[string]>("SELECT room_id,quote_json FROM cost_quotes WHERE id=?").get(quoteId);
      const detail=quote?JSON.parse(quote.quote_json) as {route?:{bindingHash?:string};expiresAt?:string}:null;
      if(!quote||quote.room_id!==preview.roomId||detail?.route?.bindingHash!==preview.bindingHash||!detail.expiresAt||!Number.isFinite(Date.parse(detail.expiresAt))||Date.parse(detail.expiresAt)<=(this.options.now??(()=>new Date()))().getTime())throw new Error("routing_quote_mismatch");
    }
    const decision:RouteDecision={...structuredClone(preview),id:crypto.randomUUID(),rootTaskId,quoteId,createdAt:(this.options.now??(()=>new Date()))().toISOString()};
    this.db.query("INSERT INTO routing_decisions(id,root_task_id,room_id,quote_id,binding_hash,decision_json,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(decision.id,rootTaskId,preview.roomId,quoteId,preview.bindingHash,JSON.stringify(decision),decision.createdAt);
    return decision;
  }
  get(rootTaskId:string):RouteDecision|null {
    const row=this.db.query<{decision_json:string},[string]>("SELECT decision_json FROM routing_decisions WHERE root_task_id=?").get(rootTaskId);
    return row?JSON.parse(row.decision_json) as RouteDecision:null;
  }
}
