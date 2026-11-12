import { describe, expect, it } from "bun:test";
import { selectRoute, DEFAULT_ROUTE_LIMITS, type RoutingInput, type RoutingMember, type TaskFeatures } from "./routing";
import type { PriceSnapshot } from "./cost";
import { DEFAULT_COLLABORATION_SETTINGS, normalizeCollaborationSettings, resolveCollaborationDefaults, validateCollaborationSettings } from "./room-kind";

const at = "2026-11-08T00:00:00.000Z";
function member(agentId: string, rate = "1"): RoutingMember {
  const price: PriceSnapshot = { id: `price:${agentId}`, contentHash: agentId, providerConnectionId: agentId, upstreamProvider: "fixture", modelId: "fixture", protocol: "openai_chat_completions", baseUrl: "https://fixture.invalid/v1", serviceTier: "default", currency: "USD", rates: { input:rate,output:rate }, source:"user_confirmed",sourceVersion:"fixture/1",sourceUrl:"local:fixture",fetchedAt:at,validFrom:at,validUntil:null,billingMode:"metered",explicitlyFree:false,usageSemantics:{inputIncludesCacheRead:true,inputIncludesCacheWrite:true,outputIncludesReasoning:true},unsupportedDimensions:[],tiers:[] };
  return {agentId,providerId:agentId,modelId:"fixture",enabled:true,credentialAvailable:true,executionEligible:true,egressAllowed:true,capabilities:{textInput:true,imageInput:false,fileInput:false,toolCalling:true,streaming:true,runtimeKinds:["native"],reasoningEfforts:["auto"]},contextWindowTokens:128000,protocol:"openai_chat_completions",price};
}
const local: TaskFeatures = { selectedPaths:["README.md"],fileCount:1,modulePaths:[],independentModuleCount:0,dependencyEdges:[],sharedStateCoupled:false,scripts:[],risk:"ordinary",riskReasons:[],verification:"machine",verificationCheckIds:["file"],requiredCapabilities:{textInput:true,toolCalling:true,imageInput:false,fileInput:false},inputTokensEstimate:1000,contextTokensRequired:2000,scope:"local",evidence:"workspace_metadata",unknowns:[] };
function input(extra: Partial<RoutingInput> = {}): RoutingInput {
  return {preset:"economy",strategy:"adaptive",primaryAgentId:"expensive",managerId:"expensive",reviewerId:null,allowedAgentIds:["cheap","medium","expensive"],lockedAgentIds:[],fallbackAgentIds:[],members:[member("cheap"),member("medium","2"),member("expensive","10")],features:local,limits:{...DEFAULT_ROUTE_LIMITS},budget:null,maxOutputTokens:1000,at,...extra};
}
describe("deterministic workflow routing",()=>{
  it("a small document edit uses one eligible worker and has no Manager stage",()=>{
    const result=selectRoute(input());
    expect(result.selected?.workflow).toBe("direct");
    expect(result.selected?.assignments).toEqual({managerId:null,executorIds:["cheap"],reviewerId:null});
    expect(result.selected?.stages.filter(stage=>stage.stage==="planning")).toEqual([]);
    expect(result.reasonCodes).toContain("single_sufficient");
  });
  it("hard exclusions apply before optimizing, and a locked member is never replaced",()=>{
    const members=[member("cheap"),member("medium"),member("expensive")];
    members[0]!.credentialAvailable=false;members[1]!.egressAllowed=false;
    const result=selectRoute(input({members,lockedAgentIds:["cheap"]}));
    expect(result.selected).toBeNull();
    expect(result.exclusions.find(row=>row.agentId==="cheap")?.reasonCodes).toContain("provider_credentials_unavailable");
    expect(result.exclusions.find(row=>row.agentId==="expensive")?.reasonCodes).toContain("explicit_member_constraint");
  });
  it("unknown price cannot win as cheapest and strict budgets reject reference estimates",()=>{
    const cheap=member("cheap","0.000001");cheap.price={...cheap.price!,source:"preset_estimate",estimateReason:"unknown_model"};
    expect(selectRoute(input({members:[cheap,member("medium","2")]})).selected?.assignments.executorIds).toEqual(["medium"]);
    const result=selectRoute(input({members:[cheap],allowedAgentIds:["cheap"],budget:{mode:"strict_admission",limitAtomic:"999999999999999"}}));
    expect(result.selected).toBeNull();expect(result.exclusions[0]?.reasonCodes).toContain("strict_price_unavailable");
  });
  it("modalities, tool support, context and disabled providers are real hard constraints",()=>{
    const members=[member("cheap"),member("medium"),member("expensive")];
    members[0]!.capabilities.toolCalling="unknown";members[1]!.contextWindowTokens=100;members[2]!.enabled=false;
    const result=selectRoute(input({members}));
    expect(result.selected).toBeNull();
    expect(result.exclusions.map(e=>e.reasonCodes).flat()).toEqual(expect.arrayContaining(["capability_missing:toolCalling","context_window_insufficient","provider_disabled"]));
  });
  it("the same multi-module evidence produces explainable preset differences and preserves Custom",()=>{
    const features:TaskFeatures={...local,selectedPaths:["apps/a/index.ts","apps/b/index.ts"],fileCount:2,modulePaths:["apps/a","apps/b"],independentModuleCount:2,scope:"multi_module"};
    const economy=selectRoute(input({features})),balanced=selectRoute(input({features,preset:"balanced"})),quality=selectRoute(input({features,preset:"quality"}));
    expect(economy.selected?.workflow).toBe("direct");
    expect(balanced.selected?.workflow).toBe("plan_execute");
    expect(quality.selected?.workflow).toBe("team");
    const custom=selectRoute(input({features,preset:"custom",strategy:"single"}));
    expect(custom.selected?.assignments.executorIds).toEqual(["expensive"]);
    expect(custom.selected?.workflow).toBe("direct");
  });
  it("highly coupled changes and unverified tasks do not invent delegation benefits",()=>{
    const features={...local,scope:"multi_module" as const,modulePaths:["apps/a","apps/b"],independentModuleCount:2,sharedStateCoupled:true};
    const result=selectRoute(input({features,preset:"quality"}));
    expect(result.candidates.filter(c=>c.workflow==="team"&&c.feasible)).toHaveLength(0);
    const withoutChecks=selectRoute(input({features:{...features,sharedStateCoupled:false,verification:"unconfigured"},preset:"quality"}));
    expect(withoutChecks.selected?.workflow).toBe("direct");
  });
  it("quality respects the whole workflow cost budget and selected candidate IDs remain bound",()=>{
    const result=selectRoute(input({preset:"quality",budget:{mode:"strict_admission",limitAtomic:"1"}}));
    expect(result.selected).toBeNull();expect(result.reasonCodes).toContain("no_feasible_route");
    expect(()=>selectRoute(input({selectedCandidateId:"invented"}))).toThrow("routing_candidate_unavailable");
    const first=selectRoute(input());expect(selectRoute(input()).candidates).toEqual(first.candidates);
    expect(selectRoute(input({selectedCandidateId:first.selectedCandidateId!})).selected).toEqual(first.selected);
  });
  it("one member adaptive is valid and only explicitly allowed fallback survives filtering",()=>{
    const settings=normalizeCollaborationSettings({...DEFAULT_COLLABORATION_SETTINGS,strategy:"adaptive",assignment:{...DEFAULT_COLLABORATION_SETTINGS.assignment,routing:{...DEFAULT_COLLABORATION_SETTINGS.assignment.routing,limits:{maxRetries:0,maxEscalations:0,maxTotalModelCalls:4},fallbackAgentIds:["only"],allowedProviderIds:[]}}});
    expect(validateCollaborationSettings({kind:"cowork",workspaceId:"ws",agentIds:["only"]},settings)).toEqual([]);
    expect(resolveCollaborationDefaults(settings,{kind:"cowork",workspaceId:"ws",agentIds:["only"]},"only").strategy).toBe("adaptive");
    expect(settings.assignment.routing.limits).toEqual({maxRetries:0,maxEscalations:0,maxTotalModelCalls:4});
    expect(settings.assignment.routing.allowedProviderIds).toEqual([]);
    const result=selectRoute(input({members:[member("only")],allowedAgentIds:["only"],primaryAgentId:"only",managerId:null,fallbackAgentIds:["outside"]}));
    expect(result.selected?.workflow).toBe("direct");expect(result.fallbackAgentIds).toEqual([]);
  });
  it("Custom team retains the explicit workflow even when automatic delegation would be unjustified",()=>{
    const result=selectRoute(input({preset:"custom",strategy:"team",features:{...local,verification:"unconfigured"}}));
    expect(result.selected?.workflow).toBe("team");expect(result.selected?.assignments.managerId).toBe("expensive");
    expect(result.selected?.assignments.executorIds).toEqual(["cheap","medium","expensive"]);
  });
  it("freezes same-workflow fallback candidates without letting them replace the initial recommendation",()=>{
    const features:TaskFeatures={...local,modulePaths:["apps/a","apps/b"],independentModuleCount:2,scope:"multi_module"};
    const result=selectRoute(input({features,preset:"balanced",fallbackAgentIds:["medium"]}));
    expect(result.selected?.assignments).toEqual({managerId:"expensive",executorIds:["cheap"],reviewerId:null});
    const fallback=result.candidates.find(candidate=>candidate.workflow==="plan_execute"&&candidate.assignments.executorIds[0]==="medium");
    expect(fallback).toMatchObject({fallbackOnly:true,feasible:true,assignments:{managerId:"expensive",executorIds:["medium"],reviewerId:null}});
    expect(fallback?.priceSnapshotIds).toContain("price:medium");
  });
  it("official price references are known tariffs while an unsupported runtime remains excluded",()=>{
    const a=member("cheap");a.price={...a.price!,source:"official",estimateReason:"official_reference"};
    const b=member("medium");b.capabilities.runtimeKinds=["langgraph_socrates"];
    const result=selectRoute(input({members:[a,b],budget:{mode:"strict_admission",limitAtomic:"999999999999999"}}));
    expect(result.selected?.assignments.executorIds).toEqual(["cheap"]);
    expect(result.exclusions.find(row=>row.agentId==="medium")?.reasonCodes).toContain("native_runtime_unsupported");
  });
  it("Custom fixed worker and explicitly allowed direct fallback both remain executable identities",()=>{
    const result=selectRoute(input({preset:"custom",strategy:"single",customExecutorId:"medium",fallbackAgentIds:["cheap"]}));
    expect(result.selected?.assignments.executorIds).toEqual(["medium"]);
    expect(result.candidates.find(c=>c.assignments.executorIds[0]==="cheap")).toMatchObject({workflow:"direct",fallbackOnly:true});
    expect(selectRoute(input({preset:"custom",strategy:"team",customExecutorId:"medium"})).selected?.assignments.executorIds).toEqual(["medium"]);
  });
  it("Custom team quotes every configured discussion turn before planning",()=>{
    const result=selectRoute(input({preset:"custom",strategy:"team",customExecutorId:"cheap",discussion:{enabled:true,mode:"round_robin",maxRounds:3,speakerOrder:["cheap","medium"],summaryAgentId:"expensive"}}));
    const stage=result.selected?.stages.find(s=>s.stage==="discussion");
    expect(stage).toMatchObject({agentIds:["cheap","medium"],lowCalls:3,highCalls:3});
    expect(result.selected?.modelCalls.low).toBe(8);
    expect(result.selected?.resolved.agentIds).toEqual(expect.arrayContaining(["cheap","medium","expensive"]));
  });
  it("Custom team explicit single member uses only that member while preserving admission constraints",()=>{
    const locked=input({preset:"custom",strategy:"team",lockedAgentIds:["cheap"],reviewerId:"medium",fallbackAgentIds:["medium"],
      discussion:{enabled:true,mode:"round_robin",maxRounds:1,speakerOrder:["medium"],summaryAgentId:"expensive"}});
    const result=selectRoute(locked);
    expect(result.selected?.assignments).toEqual({managerId:null,executorIds:["cheap"],reviewerId:null});
    expect(result.selected?.stages.find(stage=>stage.stage==="discussion")).toBeUndefined();
    expect(result.fallbackAgentIds).toEqual([]);
    expect(result.candidates.every(candidate=>candidate.assignments.executorIds.join() === "cheap")).toBe(true);
    const denied=structuredClone(locked);denied.members.find(item=>item.agentId==="cheap")!.credentialAvailable=false;
    expect(selectRoute(denied).selected).toBeNull();
    const adaptive=selectRoute(input({lockedAgentIds:["cheap"],preset:"quality",features:{...local,scope:"multi_module",independentModuleCount:2}}));
    expect(adaptive.selected?.resolved).toEqual({kind:"direct",agentIds:["cheap"]});
  });
});
