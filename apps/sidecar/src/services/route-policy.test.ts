import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../db";
import { SessionStore } from "../store/session-store";
import { WorkspaceManager } from "../workspace/manager";
import { PricingStore } from "./pricing-store";
import { RoutePolicyService, type RouteQuoteInput } from "./route-policy";
import type { RoomCollaborationSettings } from "@socrates/core";

describe("RoutePolicyService frozen authorized evidence",()=>{
  let base:string,root:string,db:Database,sessions:SessionStore,roomId:string,workspaceId:string,service:RoutePolicyService,input:RouteQuoteInput;
  const now=()=>new Date("2026-11-08T00:00:00.000Z");
  beforeEach(()=>{
    base=mkdtempSync(join(tmpdir(),"socrates-routing-"));root=join(base,"workspace");mkdirSync(root);
    writeFileSync(join(root,"README.md"),"A controlled document");
    db=openDb(join(base,"facts.sqlite"));sessions=new SessionStore(db);const wm=new WorkspaceManager(db,join(base,"managed"));workspaceId=wm.select(root).id;
    for(const id of ["a","b","c"]){
      db.query("INSERT INTO providers(id,name,type,base_url,api_key_ref,enabled,created_at,updated_at) VALUES (?,?,'openai_compatible','https://fixture.invalid/v1',?,1,'now','now')").run(id,id,`secret:${id}`);
      new PricingStore(db).save({providerConnectionId:id,modelId:"fixture",protocol:"openai_chat_completions",baseUrl:"https://fixture.invalid/v1",currency:"USD",rates:{input:id==="a"?"10":id==="b"?"1":"2",output:id==="a"?"10":id==="b"?"1":"2"},source:"user_confirmed",sourceVersion:"fixture/1",validFrom:now().toISOString(),fetchedAt:now().toISOString()});
    }
    const room=sessions.create({title:"Preserve room history",mode:"multi_agent",workspaceId,primaryAgentId:"a",agents:["a","b","c"].map(agentId=>({agentId,executionEligible:true,snapshot:{providerId:agentId,modelId:"fixture",nickname:agentId,systemPrompt:"Controlled fixture",modelCapabilities:{textInput:true,toolCalling:true,imageInput:false,fileInput:false,streaming:true,contextWindowTokens:128000,runtimeKinds:["native"],reasoningEfforts:["auto"]}}}))});
    roomId=room.id;
    settings({...room.collaboration,strategy:"adaptive",assignment:{...room.collaboration.assignment,coordinatorAgentId:"a",routing:{...room.collaboration.assignment.routing,automaticPolicy:"cost"}}});
    service=new RoutePolicyService(db,sessions,{hasCredentials:()=>true,now});
    input={roomId,content:"Update README.md",mentions:[],intent:"execute",maxOutputTokens:1024};
  });
  afterEach(()=>{db.close();rmSync(base,{recursive:true,force:true});});
  function settings(collaboration:RoomCollaborationSettings){db.query("UPDATE sessions SET collaboration_json=? WHERE id=?").run(JSON.stringify(collaboration),roomId);}
  function command(id:string,body:RouteQuoteInput=input){db.query("INSERT INTO room_commands(id,room_id,client_request_id,fingerprint,input_json,kind,status,created_at,updated_at) VALUES (?,?,?,'fixture',?,'direct','created','now','now')").run(id,roomId,id,JSON.stringify({...body,clientRequestId:id}));}
  function ref(id:string,path:string){db.query("INSERT INTO workspace_refs(id,workspace_id,relative_path,kind,snapshot_hash,snapshot_size,created_at) VALUES (?,?,?,'file','fixture',32,'now')").run(id,workspaceId,path);}
  function verification(){
    const plan={id:"verification",hash:"approved-hash",target:{roomId,rootTaskId:"draft:fixture"},approvalStatus:"approved",checks:[{id:"tests",kind:"file",required:true,origin:"user",path:"README.md"}],manualJudgment:[]};
    db.query("INSERT INTO verification_plans(id,room_id,root_task_id,package_id,version,request_id,request_hash,plan_json,created_at) VALUES ('verification',?,'draft:fixture','',1,'fixture','fixture',?,'now')").run(roomId,JSON.stringify(plan));
    return plan.id;
  }
  it("reads real selected scope, picks a single worker without model calls and freezes complete profiles",()=>{
    const preview=service.preview(input);expect(preview.features.selectedPaths).toEqual(["README.md"]);expect(preview.features.fileCount).toBe(1);
    expect(preview.selected?.workflow).toBe("direct");expect(preview.selected?.assignments.executorIds).toEqual(["b"]);
    expect(db.query("SELECT * FROM cost_invocations").all()).toHaveLength(0);
    command("root");const frozen=service.freeze("root",preview,null);
    expect(frozen.members.b?.profile.modelId).toBe("fixture");expect(frozen.members.b?.provider.baseUrl).toBe("https://fixture.invalid/v1");
    expect(JSON.stringify(frozen)).not.toContain("secret:");
    expect(service.freeze("root",preview,null).id).toBe(frozen.id);
    db.close();db=openDb(join(base,"facts.sqlite"));sessions=new SessionStore(db);service=new RoutePolicyService(db,sessions,{hasCredentials:()=>false,now});
    expect(service.get("root")).toEqual(frozen);expect(sessions.get(roomId)?.title).toBe("Preserve room history");
  });
  it("freezes current prices and rejects a changed request/configuration or edited preview at freeze",()=>{
    const preview=service.preview(input);command("root");
    writeFileSync(join(root,"README.md"),"A different artifact");expect(()=>service.freeze("root",preview,null)).toThrow("routing_preview_stale");
    const current=service.preview(input);const changed=structuredClone(current);changed.selected!.assignments.executorIds=["a"];
    expect(()=>service.freeze("root",changed,null)).toThrow("routing_preview_invalid");
    const frozen=service.freeze("root",current,null);db.query("UPDATE providers SET base_url='https://changed.invalid/v1' WHERE id='b'").run();
    expect(service.get("root")?.members.b?.provider.baseUrl).toBe("https://fixture.invalid/v1");expect(service.get("root")?.selected?.priceSnapshotIds).toEqual(frozen.selected?.priceSnapshotIds);
  });
  it("a quote for another candidate in the same room cannot authorize this decision",()=>{
    const preview=service.preview(input);command("root");
    db.query("INSERT INTO cost_quotes(id,room_id,input_hash,quote_json,created_at,expires_at) VALUES ('wrong',?,'wrong',?,'now','2027-01-01T00:00:00.000Z')")
      .run(roomId,JSON.stringify({roomId,expiresAt:"2027-01-01T00:00:00.000Z",route:{bindingHash:"different"}}));
    expect(()=>service.freeze("root",preview,"wrong")).toThrow("routing_quote_mismatch");
    expect(service.get("root")).toBeNull();
  });
  it("uses manifests and dependency edges rather than a long prompt to infer separable modules",()=>{
    for(const name of ["a","b"]){mkdirSync(join(root,"apps",name),{recursive:true});writeFileSync(join(root,"apps",name,"package.json"),JSON.stringify({name:`module-${name}`,scripts:{test:"bun test"}}));writeFileSync(join(root,"apps",name,"index.ts"),"export const value=1;");ref(`ref-${name}`,`apps/${name}/index.ts`);}
    const planId=verification();const body={...input,content:"Update the two selected independent modules",workspaceRefIds:["ref-a","ref-b"],verificationPlanId:planId};
    const room=sessions.get(roomId)!;settings({...room.collaboration,assignment:{...room.collaboration.assignment,routing:{...room.collaboration.assignment.routing,automaticPolicy:"quality"}}});
    const independent=service.preview(body);expect(independent.features.independentModuleCount).toBe(2);expect(independent.selected?.workflow).toBe("team");
    writeFileSync(join(root,"apps","b","package.json"),JSON.stringify({name:"module-b",dependencies:{"module-a":"workspace:*"},scripts:{test:"bun test"}}));
    const coupled=service.preview(body);expect(coupled.features.sharedStateCoupled).toBe(true);expect(coupled.selected?.workflow).not.toBe("team");
    const lengthy=service.preview({...input,content:"Update README.md. "+"Unrelated explanatory prose. ".repeat(1000)});
    expect(lengthy.features.scope).toBe("local");expect(lengthy.selected?.workflow).toBe("direct");
  });
  it("explicit mentions, credential checks, provider egress and strict prices never silently fall back",()=>{
    const restricted=new RoutePolicyService(db,sessions,{hasCredentials:id=>id!=="b",now});
    expect(restricted.preview({...input,mentions:[{type:"agent",agentId:"b"}]}).selected).toBeNull();
    const room=sessions.get(roomId)!;settings({...room.collaboration,assignment:{...room.collaboration.assignment,routing:{...room.collaboration.assignment.routing,allowedProviderIds:[]}}});
    const denied=service.preview(input);expect(denied.selected).toBeNull();expect(denied.exclusions.every(e=>e.reasonCodes.includes("provider_egress_disallowed"))).toBe(true);
    settings({...room.collaboration,assignment:{...room.collaboration.assignment,callableAgentIds:["b"],routing:{...room.collaboration.assignment.routing,fallbackAgentIds:["a"]}}});
    expect(()=>service.preview(input)).toThrow("fallback_agents_must_be_callable_members");
  });
  it("does not claim independent modules when their dependency format has not been parsed",()=>{
    for(const name of ["a","b"]){mkdirSync(join(root,name),{recursive:true});writeFileSync(join(root,name,"Cargo.toml"),`[package]\nname = "module-${name}"\n[dependencies]\nmodule-a = { path = "../a" }\n`);writeFileSync(join(root,name,"lib.rs"),"pub fn work() {}\n");ref(`rust-${name}`,`${name}/lib.rs`);}
    const room=sessions.get(roomId)!;settings({...room.collaboration,assignment:{...room.collaboration.assignment,routing:{...room.collaboration.assignment.routing,automaticPolicy:"quality"}}});
    const preview=service.preview({...input,content:"Update the selected modules",workspaceRefIds:["rust-a","rust-b"],verificationPlanId:verification()});
    expect(preview.features.sharedStateCoupled).toBe(true);
    expect(preview.features.unknowns).toContain("dependency_graph_unavailable:a/Cargo.toml");
    expect(preview.selected?.workflow).toBe("direct");
  });
  it("rejects another workspace's ref and does not open secret files or follow symlink inputs",()=>{
    const other=join(base,"other");mkdirSync(other);
    db.query("INSERT INTO workspace_refs(id,workspace_id,relative_path,kind,snapshot_hash,created_at) VALUES ('outside',?,'README.md','file','fixture','now')").run(new WorkspaceManager(db,join(base,"managed")).select(other).id);
    expect(()=>service.preview({...input,workspaceRefIds:["outside"]})).toThrow("workspace_reference_out_of_scope");
    ref("secret",".env");writeFileSync(join(root,".env"),"NEVER_UPLOAD=private");
    expect(()=>service.preview({...input,workspaceRefIds:["secret"]})).toThrow("workspace_secret_path_denied");
    writeFileSync(join(base,"outside.txt"),"Out of scope");symlinkSync(join(base,"outside.txt"),join(root,"linked.txt"));ref("linked","linked.txt");
    expect(()=>service.preview({...input,workspaceRefIds:["linked"]})).toThrow("workspace_symlink_denied");
  });
  it("keeps a one-member adaptive room and Custom fixed primary meaningful",()=>{
    const room=sessions.get(roomId)!;settings({...room.collaboration,assignment:{...room.collaboration.assignment,callableAgentIds:["a"],routing:{...room.collaboration.assignment.routing,mode:"manual"}}});
    const custom=service.preview(input);expect(custom.preset).toBe("custom");expect(custom.selected?.assignments.executorIds).toEqual(["a"]);
    expect(custom.fallbackAgentIds).toEqual([]);
  });
  it("Custom consumes the configured local worker and an explicit mention takes precedence",()=>{
    const room=sessions.get(roomId)!;settings({...room.collaboration,strategy:"single",assignment:{...room.collaboration.assignment,routing:{...room.collaboration.assignment.routing,mode:"manual",lightweightAgentId:"c"}}});
    expect(service.preview(input).selected?.assignments.executorIds).toEqual(["c"]);
    expect(service.preview({...input,mentions:[{type:"agent",agentId:"b"}]}).selected?.assignments.executorIds).toEqual(["b"]);
    db.query("UPDATE providers SET enabled=0 WHERE id='c'").run();
    expect(service.preview(input).selected).toBeNull();
  });
});
