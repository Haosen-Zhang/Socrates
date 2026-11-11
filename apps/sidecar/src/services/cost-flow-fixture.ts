import { ArenaArtifactService } from "./arena-artifacts";
import { arenaArtifactRoutes } from "../routes/arena-artifacts";
import { ArenaStrategyService } from "./arena-strategy";
import { arenaStrategyRoutes } from "../routes/arena-strategy";
import { ArenaService } from "./arena-service";
import { arenaRoutes } from "../routes/arena";
import { FlightRecorderService } from "./flight-recorder";
import { flightRecorderRoutes } from "../routes/flight-recorder";
import { ProjectMemoryService } from "./project-memory";
import { projectMemoryRoutes } from "../routes/project-memory";
import { adaptiveEvidenceContext } from "./adaptive-context";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { evaluatePermission, type ModelGateway, type OrchestrationAgent, type StructuredPlan } from "@socrates/core";
import { openDb } from "../db";
import { SessionStore } from "../store/session-store";
import { EventStore } from "../store/event-store";
import { ExecutionEventStore } from "../store/execution-event-store";
import { ApprovalManager } from "../approvals/manager";
import { WorkspaceManager } from "../workspace/manager";
import { WorkspaceLeaseManager } from "../workspace/leases";
import { WorkspacePathPolicy } from "../workspace/path-policy";
import { ToolOutputStore } from "../tools/output-store";
import { createNativeBuiltinTools } from "../tools/native-builtins";
import { ToolRegistry } from "../tools/registry";
import { ToolExecutor } from "../tools/executor";
import { RuntimeManager } from "../runtime/runtime-manager";
import { NativeAgentRuntime, createAiSdkNativeStream } from "../runtime/native-agent-runtime";
import { SingleAgentRunner } from "../runtime/single-agent-runner";
import { RunSupervisor } from "../runtime/run-supervisor";
import { ExecutionRunner } from "../runtime/execution-runner";
import { AttachmentResolver } from "../attachments/resolver";
import { createAiSdkModel, makeAiSdkGateway } from "../gateway-aisdk";
import { MultiTaskStore } from "../multi-agent/task-store";
import { MultiAgentCoordinator } from "../multi-agent/coordinator";
import { WorkPackageStore } from "../multi-agent/work-package-store";
import { TeamRunner } from "../multi-agent/team-runner";
import { ModelInvocationBroker } from "./model-invocation-broker";
import { RoomCommandService } from "./room-command-service";
import { CostTaskService } from "./cost-task-service";
import { TaskQuoteService } from "./task-quotes";
import { UsageCollector } from "./usage-collector";
import { resolveRunProfile, resolveSessionRunProfile, type RunProfile } from "./run-profile";
import { resolveRoomFileContext } from "./room-file-context";
import { costRoutes } from "../routes/cost";
import { roomCommandRoutes } from "../routes/room-commands";
import { multiAgentRoutes } from "../routes/multi-agent";
import { agentRunRoutes } from "../routes/agent-runs";
import { sessionRoutes } from "../routes/sessions";
import { workspaceRoutes } from "../routes/workspaces";
import { contentRoutes } from "../routes/content";
import { ConfigStore, configRoutes } from "../config-store";
import { MemorySecrets } from "../secrets";
import { providerRoutes } from "../providers";
import { agentRoutes } from "../agents";
import { VerificationService } from "./verification-service";
import { taskVerificationTarget } from "./work-verification";
import { verificationRoutes } from "../routes/verification";
import { RoutePolicyService } from "./route-policy";
import { AdaptiveWorkflowService } from "./adaptive-workflow";
import { createAdaptiveHosts } from "./adaptive-hosts";
import { routingRoutes } from "../routes/routing";

export async function untilCostFlow(predicate: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`fixture_timeout:${label}`);
    await Bun.sleep(5);
  }
}

const TOKEN_USAGE = { inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const PLAN: StructuredPlan = {
  objective: "Complete the controlled collaboration", summary: "Write once, read fixture, then independently review the report.", evidence: [],
  steps: [{ id: "1", title: "Fixture delivery", description: "Use only temporary workspace files", files: ["result.txt", "context.txt"], commands: [], risks: [], verification: ["Inspect the fixture result"] }],
  workPackages: [
    { id: "write", title: "Write fixture result", objective: "Write result once and read the supplied fixture context", input: "Use write_file for result.txt and read_file for context.txt", dependencies: [], executorAgentId: "fixture-a", reviewerAgentId: "fixture-b", expectedFiles: ["result.txt"], acceptanceCriteria: ["The fixture result exists"] },
    { id: "report", title: "Report fixture result", objective: "Report what the first member completed", input: "Use the first package result", dependencies: ["write"], executorAgentId: "fixture-b", reviewerAgentId: "fixture-a", expectedFiles: [], acceptanceCriteria: ["Report includes the completed package"] },
  ],
};

/** Real production services; only the Provider stream and disposable test files are controlled. */
export async function setupCostFlowFixture(options: { strictBoundFixture?: boolean; missingFirstNativeUsage?: boolean; reasoningPlanner?: boolean; writeApprovalFlow?: boolean; scopeExpansion?: boolean; invalidWriteHash?: boolean; automaticPricingView?: boolean; routingFixture?:boolean; nativeToolCalls?:(body:unknown)=>Array<{id:string;type:string;function:{name:string;arguments:string}}>|undefined; onNativeRequest?:(body:unknown)=>void; onGatewayRequest?:(request:unknown)=>void } = {}) {
  // Synthetic trusted-bound metadata only: Native fetch still targets fixture.invalid
  // through controlledFetch; planning/review use the local generator below.
  const admissionBaseUrl = options.strictBoundFixture ? "https://api.openai.com/v1" : "https://fixture.invalid/v1";
  const catalogBound = (id:string) => options.strictBoundFixture ? {tokens:id === "fixture-c" ? 128000 : 1024,providerId:"openai",revision:"synthetic-strict-bound-fixture/1"} : undefined;
  const directory = mkdtempSync(join(tmpdir(), "socrates-cost-flow-"));
  const workspacePath = join(directory, "workspace");
  mkdirSync(workspacePath);
  writeFileSync(join(workspacePath, "context.txt"), "Synthetic public fixture context. ".repeat(400));
  const db = openDb(join(directory, "fixture.db"));
  const token = "socrates-cost-controlled-fixture";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const secrets = new MemorySecrets(); secrets.set("fixture-key", "fixture-not-a-real-key");
  const now = new Date().toISOString();
  db.query(`INSERT INTO providers(id,name,type,base_url,default_model,api_key_ref,enabled,created_at,updated_at)
    VALUES ('fixture-provider','Controlled fixture Provider','openai_compatible','https://fixture.invalid/v1','fixture-model-a','fixture-key',1,?,?)`).run(now, now);
  if(options.strictBoundFixture)db.query("UPDATE providers SET base_url=? WHERE id='fixture-provider'").run(admissionBaseUrl);
  const snapshots = (options.routingFixture?["a","b","c"]:["a", "b"]).map(suffix => ({ id: `fixture-${suffix}`, nickname: suffix === "a" ? "Fixture Builder" : suffix === "b" ? "Fixture Reviewer" : "Fixture Specialist", avatar: suffix === "a" ? "/avatars/owl-engineer.webp" : "/avatars/cat-astronaut.webp",
    providerId: "fixture-provider", modelId: `fixture-model-${suffix}`, role: "Controlled fixture member", systemPrompt: "Operate only on synthetic test input.",
    reasoningEffort: "auto", configurationVersion: "fixture-v1", modelCapabilities: { textInput: true, imageInput: false, fileInput: false, toolCalling: true, streaming: true,
      reasoningEfforts: ["auto"], runtimeKinds: ["native"], contextWindowTokens: suffix === "c" ? 256000 : 128000 } }));
  for (const s of snapshots) db.query(`INSERT INTO agents(id,display_name,nickname,avatar,provider_id,model_id,role,system_prompt,reasoning_effort,model_capabilities_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(s.id, s.nickname, s.nickname, s.avatar, s.providerId, s.modelId, s.role, s.systemPrompt, s.reasoningEffort, JSON.stringify(s.modelCapabilities), now, now);
  const sessions = new SessionStore(db);
  const workspaces = new WorkspaceManager(db, join(directory, "managed"));
  const workspace = workspaces.select(workspacePath);
  const members = snapshots.map(s => ({ agentId: s.id, snapshot: { ...s }, executionEligible: true }));
  const work = sessions.create({ title: "Cost fixture Work", mode: "multi_agent", workspaceId: workspace.id, primaryAgentId: "fixture-a", agents: members });
  sessions.updateCollaboration(work.id, { ...work.collaboration, strategy: "team", assignment: { ...work.collaboration.assignment, coordinatorAgentId: "fixture-a" }, discussion: { ...work.collaboration.discussion, enabled: false }, planConfirmation: { ...work.collaboration.planConfirmation, mode: "user" } });
  sessions.updateApprovalPolicy(work.id, options.writeApprovalFlow ? "ask" : "workspace_full");
  const chat = sessions.create({ title: "Cost fixture Chat", mode: "chat", primaryAgentId: "fixture-a", agents: members });
  sessions.updateCollaboration(chat.id, { ...chat.collaboration, discussion: { ...chat.collaboration.discussion, enabled: true, maxRounds: 1, speakerOrder: ["fixture-a", "fixture-b"], summaryAgentId: "fixture-b" } });
  const events = new EventStore(db), executionEvents = new ExecutionEventStore(db), approvals = new ApprovalManager(db);
  const outputs = new ToolOutputStore(db), leases = new WorkspaceLeaseManager(db, "cost-fixture-instance");
  const runtimes = new RuntimeManager(db, executionEvents), broker = new ModelInvocationBroker(db);
  for (const s of snapshots) broker.prices.save({ providerConnectionId: s.providerId, modelId: s.modelId, protocol: options.strictBoundFixture ? "openai_responses" : "openai_chat_completions", baseUrl: admissionBaseUrl,
    currency: "USD", rates: { input: options.routingFixture && s.id === "fixture-c" ? "3" : "1", output: options.routingFixture && s.id === "fixture-c" ? "3" : "1", cacheRead: "0", cacheWrite: "0" }, source: "user_confirmed", sourceVersion: "synthetic-fixture/1",
    usageSemantics: { inputIncludesCacheRead: true, inputIncludesCacheWrite: true, outputIncludesReasoning: true } });
  if (options.automaticPricingView) {
    for (const p of [{ id: "pricing-openai", name: "Official OpenAI reference", baseUrl: "https://api.openai.com/v1", model: "gpt-5.6-luna" },
      { id: "pricing-deepseek", name: "Official DeepSeek reference", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" }]) {
      db.query("INSERT INTO providers(id,name,type,base_url,default_model,api_key_ref,enabled,created_at,updated_at) VALUES (?,?,'openai_compatible',?,?,'fixture-key',1,?,?)")
        .run(p.id, p.name, p.baseUrl, p.model, now, now);
    }
    for (const [i, sample] of [
      { provider: "pricing-openai", model: "gpt-5.6-luna", historic: true, usage: { inputTokens: 2726, outputTokens: 39, cachedInputTokens: 0, cacheWriteTokens: 2723 } },
      { provider: "pricing-deepseek", model: "deepseek-v4-flash", historic: true, usage: { inputTokens: 1020, outputTokens: 1024, cachedInputTokens: 0 } },
      { provider: "pricing-openai", model: "gpt-6-luna", historic: false, usage: { inputTokens: 3023, outputTokens: 30, cachedInputTokens: 0, cacheWriteTokens: 3020 } },
      { provider: "fixture-provider", model: "unlisted-model", historic: false, usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0 } },
    ].entries()) {
      const p = db.query<{ base_url: string }, [string]>("SELECT base_url FROM providers WHERE id=?").get(sample.provider)!;
      const price = sample.historic ? null : broker.prices.resolveAutomatic({ providerConnectionId: sample.provider, modelId: sample.model,
        protocol: sample.provider === "pricing-openai" ? "openai_responses" : "openai_chat_completions", baseUrl: p.base_url });
      const identity = { invocationId: `pricing-example-${i}`, logicalStepId: `pricing-example-${i}`, attemptNo: 1, roomId: work.id,
        rootTaskId: "pricing-examples", runId: "pricing-examples", agentId: i === 1 ? "fixture-b" : "fixture-a", purpose: "respond" as const,
        providerConnectionId: sample.provider, modelId: sample.model, runProfileVersion: "fixture-v1", traceId: "fixture", spanId: `example-${i}` };
      broker.ledger.begin(identity, price?.id ?? null); broker.ledger.markSent(identity.invocationId);
      broker.ledger.finish(identity.invocationId, { usage: sample.usage });
    }
  }
  const gatewayCalls: Array<{ purpose: string; agentId: string; maxOutputTokens?: number }> = [];
  const nativeCalls: Array<{ model: string; toolHistory: boolean; maxOutputTokens: unknown }> = [];
  let nextGatewayUnknown = false;
  const plan: StructuredPlan = options.writeApprovalFlow ? { ...PLAN,
    steps: PLAN.steps.map(step => ({ ...step, files: ["result.txt", "second.txt"] })),
    workPackages: PLAN.workPackages!.map(pkg => pkg.id === "write" ? { ...pkg, expectedFiles: ["result.txt", "second.txt"] } : pkg),
  } : PLAN;
  const gateway: ModelGateway = broker.wrapGateway(async function* (request) {
    const purpose = request.invocation!.purpose;
    let responsePlan=plan;
    if(options.routingFixture && purpose === "plan"){
      const task=tasks.get(request.invocation!.runId);
      if(task?.config.routeDecisionId){
        const executors=task.config.targetAgentIds ?? ["fixture-a"];
        responsePlan={...PLAN,workPackages:executors.map((executorAgentId,index)=>({id:`delivery-${index}`,title:`Delivery ${index+1}`,objective:"Inspect and deliver synthetic output",input:"Write result.txt once if absent, otherwise inspect it.",dependencies:[],executorAgentId,reviewerAgentId:task.config.routingReviewerId ?? null,expectedFiles:["result.txt","context.txt"],acceptanceCriteria:["The controlled result exists"]}))};
      }
    }
    options.onGatewayRequest?.(request);
    gatewayCalls.push({ purpose, agentId: request.invocation!.agentId, maxOutputTokens: request.maxOutputTokens });
    if (nextGatewayUnknown) {
      nextGatewayUnknown = false;
      yield { type: "delta", text: "Controlled partial response before transport failure." };
      throw new TypeError("fixture_network_disconnect_before_usage");
    }
    if (options.reasoningPlanner && purpose === "plan") {
      // Real AI SDK transport/usage mapping, with only the upstream SSE controlled.
      const sdk = makeAiSdkGateway(async (url, init) => {
        if (String(url) !== "https://fixture.invalid/v1/chat/completions") throw new Error("fixture_network_forbidden");
        const body = JSON.parse(String(init?.body)) as { max_tokens?: number };
        const truncated = (body.max_tokens ?? 0) < 32768;
        const tokens = truncated ? body.max_tokens! : 2048;
        const data = [
          { id: "fixture-plan", object: "chat.completion.chunk", created: 0, model: request.modelId,
            choices: [{ index: 0, delta: { role: "assistant", content: truncated ? "" : JSON.stringify(plan) }, finish_reason: null }] },
          { id: "fixture-plan", object: "chat.completion.chunk", created: 0, model: request.modelId,
            choices: [{ index: 0, delta: {}, finish_reason: truncated ? "length" : "stop" }],
            usage: { prompt_tokens: 1020, completion_tokens: tokens, total_tokens: 1020 + tokens,
              prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: truncated ? tokens : 1024 } } },
        ];
        return new Response([...data.map(value => `data: ${JSON.stringify(value)}`), "data: [DONE]", ""].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
      });
      yield* sdk(request);
      return;
    }
    yield { type: "delta", text: purpose === "plan" ? JSON.stringify(responsePlan) : purpose === "review" ? JSON.stringify({ verdict: "approve", notes: "Controlled review of fixture output." }) : purpose === "summarize" ? "Controlled discussion summary." : "Controlled member response." };
    yield { type: "done", usage: { ...TOKEN_USAGE }, requestId: `fixture-gateway-${gatewayCalls.length}`, finishReason: "stop" };
  });
  const controlledFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (String(url).endsWith("/models")) return Response.json({ data: snapshots.map(s => ({ id: s.modelId })) });
    if (!String(url).startsWith("https://fixture.invalid/v1/")) throw new Error("fixture_network_forbidden");
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ role: string; tool_call_id?: string }>; max_tokens?: number; tools?: unknown[] };
    const toolHistory = body.messages.some(message => message.role === "tool");
    options.onNativeRequest?.(body);
    nativeCalls.push({ model: body.model, toolHistory, maxOutputTokens: body.max_tokens });
    const firstWorkerSample = (options.routingFixture || body.model === "fixture-model-a") && !toolHistory && !!body.tools?.length;
    let calls = firstWorkerSample ? [
      { id: "fixture-write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "result.txt", content: "Written once by controlled Native tool.\n" }) } },
      { id: "fixture-read", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "context.txt" }) } },
    ] : [];
    if(options.routingFixture && existsSync(join(workspacePath,"result.txt")))calls=calls.filter(call=>call.function.name!=="write_file");
    if (options.writeApprovalFlow && body.model === "fixture-model-a" && body.tools?.length) {
      const paths = options.scopeExpansion ? ["result.txt", "second.txt", "outside-plan.txt"] : ["result.txt", "second.txt"];
      const index = paths.findIndex((_, i) => !body.messages.some(message => message.role === "tool" && message.tool_call_id === `approval-write-${i}`));
      calls = index < 0 ? [] : [{ id: `approval-write-${index}`, type: "function", function: { name: "write_file",
        arguments: JSON.stringify({ path: paths[index], content: `Controlled approved file ${index}\n`, expectedSha256: null }) } }];
      if (options.invalidWriteHash) {
        const invalidFinished = body.messages.some(message => message.role === "tool" && message.tool_call_id === "approval-invalid-hash");
        if (!invalidFinished) calls = [{ id: "approval-invalid-hash", type: "function", function: { name: "write_file",
          arguments: JSON.stringify({ path: "result.txt", content: "must not be written", expectedSha256: "0".repeat(64) }) } }];
        else if (!JSON.stringify(body.messages).includes("expectedSha256: null")) throw new Error("fixture_write_guidance_missing");
      }
    }
    calls = options.nativeToolCalls?.(body) ?? calls;
    const chunk = (delta: unknown, finish_reason: string | null, usage?: unknown) => ({ id: `fixture-completion-${nativeCalls.length}`, object: "chat.completion.chunk", created: 1, model: body.model,
      choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) });
    const providerUsage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } };
    const parts = [chunk(calls.length ? { role: "assistant", tool_calls: calls.map((call, index) => ({ index, ...call })) } : { role: "assistant", content: "Controlled Native member completed the assigned work." }, null),
      chunk({}, calls.length ? "tool_calls" : "stop", options.missingFirstNativeUsage && nativeCalls.length === 1 ? undefined : providerUsage)];
    return new Response(parts.map(part => `data: ${JSON.stringify(part)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream", "x-request-id": `fixture-native-${nativeCalls.length}` } });
  };
  runtimes.register("native_ai_sdk", input => {
    const room = sessions.get(input.sessionId)!;
    const member = input.runtimeOptions?.runProfile as RunProfile | undefined;
    const profile = member ?? resolveSessionRunProfile(db, input.sessionId, input.agentId);
    const selectedWorkspace = input.workspaceId ? workspaces.get(input.workspaceId) : null;
    const definitions = selectedWorkspace ? createNativeBuiltinTools(new WorkspacePathPolicy(selectedWorkspace.canonicalPath), outputs, { sessionId: room.id, workspaceIdentity: selectedWorkspace.identityHash })
      .filter(definition => ["write_file", "read_file"].includes(definition.name)) : [];
    if (selectedWorkspace && !definitions.some(definition => definition.name === "write_file")) throw new Error("fixture_native_write_unavailable");
    const registry = new ToolRegistry(definitions);
    return new NativeAgentRuntime({ sessionId: room.id, taskId: input.agentSessionId, agentId: input.agentId,
      workspaceId: selectedWorkspace?.id ?? "", workspaceIdentity: selectedWorkspace?.identityHash ?? `chat:${room.id}`,
      system: [profile.role,profile.systemPrompt,adaptiveEvidenceContext(input.runtimeOptions?.adaptiveHandoff)].filter(Boolean).join("\n\n"), registry, executor: new ToolExecutor(db, registry, approvals, undefined, executionEvents),
      allowedCapabilities: room.kind === "chat" ? [] : ["workspace_read", "workspace_write"],
      permissionForTool: definition => evaluatePermission({ action: definition.capability === "workspace_read" ? "workspace.read" : "workspace.write", resource: definition.name,
        risk: definition.risk, mode: "single_agent", phase: "executing", capabilityAllowed: room.kind !== "chat", policyVersion: room.approvalPolicy.version, approvalMode: room.approvalPolicy.mode, rules: [] }),
      stream: createAiSdkNativeStream(createAiSdkModel({ providerType: "openai_compatible", baseUrl: "https://fixture.invalid/v1", modelId: profile.modelId,
        apiKey: "fixture-not-a-real-key", fetchImpl: controlledFetch }), undefined, { providerType: "openai_compatible", baseUrl: admissionBaseUrl, modelId: profile.modelId,
        broker, invocation: { roomId: room.id, rootTaskId: String(input.runtimeOptions?.costRootTaskId ?? input.agentSessionId), runId: String(input.runtimeOptions?.costRunId ?? input.agentSessionId),
          agentId: input.agentId, providerConnectionId: profile.providerId, runProfileVersion: profile.configurationVersion, logicalStepId: input.agentSessionId,
          purpose: room.kind === "chat" ? "respond" : "execute", contextWindowTokens: profile.contextWindowTokens, catalogContextWindow: catalogBound(input.agentId),
          ...(typeof input.runtimeOptions?.costRouteAttemptId === "string" ? { routeAttemptId: input.runtimeOptions.costRouteAttemptId } : {}),
        ...(typeof input.runtimeOptions?.costWorkPackageId === "string" ? { workPackageId: input.runtimeOptions.costWorkPackageId } : {}) } }) });
  });
  const attachments = new AttachmentResolver(db, directory);
  let adaptive:AdaptiveWorkflowService;
  const routes=new RoutePolicyService(db,sessions,{hasCredentials:(_id,ref)=>Boolean(secrets.get(ref))});
  const verification = new VerificationService(db,sessions,workspaces,leases,approvals,events,executionEvents,outputs,{
    onChanged:view=>{void adaptive?.notifyVerificationProgress(view.target.rootTaskId,`verification:${view.run?.id ?? view.plan?.id}:${view.verificationStatus}:${view.outcome}`).catch(()=>{});},
  });
  const runner = new SingleAgentRunner(db, runtimes, approvals, executionEvents, attachments, undefined, leases,verification);
  const supervisor = new RunSupervisor(runner);
  const tasks = new MultiTaskStore(db);
  const resolveAgent = (agentId: string, snapshot: Record<string, unknown>): OrchestrationAgent => {
    const profile = resolveRunProfile(agentId, snapshot);
    return { id: agentId, nickname: profile.nickname, avatar: profile.avatar, modelId: profile.modelId, role: profile.role, systemPrompt: profile.systemPrompt,
      providerType: "openai_compatible", baseUrl: admissionBaseUrl, apiKey: "fixture-not-a-real-key", providerConnectionId: profile.providerId,
      runProfileVersion: profile.configurationVersion, contextWindowTokens: profile.contextWindowTokens, catalogContextWindow: catalogBound(agentId), reasoningEffort: profile.reasoningEffort };
  };
  const coordinator = new MultiAgentCoordinator(db, tasks, events, gateway, resolveAgent,undefined,verification);
  const execution = new ExecutionRunner(db, tasks, runtimes, leases, approvals, events, executionEvents,undefined,verification);
  const packages = new WorkPackageStore(db,item=>verification.view(taskVerificationTarget(db,item.taskId,item.id)).gatePassed), team = new TeamRunner(db, tasks, packages, execution, coordinator, events,undefined,verification);
  adaptive=new AdaptiveWorkflowService(db,routes,verification,createAdaptiveHosts(db,routes,sessions,supervisor,runner,tasks,coordinator,team,verification,input=>{
    const room=sessions.get(input.roomId)!;
    const refs=[...new Set([...(input.workspaceRefIds??[]),...input.mentions.flatMap(mention=>mention.type==="file"?[mention.refId]:[])])];
    return refs.length||input.attachmentIds?.length?resolveRoomFileContext(db,workspaces,attachments,room.workspaceId,refs,input.attachmentIds??[]).text:"";
  }),{pollMs:10,onChanged:view=>{
    const status=["completed","failed","cancelled"].includes(view.status)?view.status:view.status==="blocked"?"failed":["pending","running","assessing"].includes(view.status)?"running":"interrupted";
    db.query("UPDATE sessions SET status=?,updated_at=? WHERE id=?").run(status,new Date().toISOString(),view.roomId);
  }});
  const commands = new RoomCommandService(db, sessions, {
    startDirect: input => supervisor.start(input), getDirect: id => supervisor.get(id), cancelDirect: id => supervisor.cancel(id), isTeamActive: id => team.isActive(id),
    resolveFileContext: (workspaceId, refs, ids) => resolveRoomFileContext(db, workspaces, attachments, workspaceId, refs, ids),
    createTeam: async ({ sessionId, prompt, clientRequestId, targetAgentIds, inputContext }) => {
      const room = sessions.get(sessionId)!;
      const task = await coordinator.create({ sessionId, prompt, config: { speakingOrder: room.agents.map(member => member.agentId), maxRounds: 1,
        synthesizerId: room.collaboration.assignment.coordinatorAgentId ?? room.primaryAgentId, executionAgentId: room.primaryAgentId, teamExecution: true,
        clientRequestId, targetAgentIds, inputContext } });
      void coordinator.run(task.id).catch(() => {});
      return { taskId: task.id };
    }, resolveAgent, gateway, verification, routing:routes, adaptive,
  });
  const costTasks = new CostTaskService(db, commands, supervisor, runner, tasks, coordinator, team, execution,{routing:routes,adaptive});
  const quotes = new TaskQuoteService(db, sessions,routes), usage = new UsageCollector(db);
  const config = new ConfigStore(join(directory, "config.toml"), secrets);
  config.update({ language: "en", theme: "dark", soundEnabled: false });
  const app = new Hono();
  app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type"], allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] }));
  app.use("*", async (c, next) => { if (c.req.header("authorization") !== `Bearer ${token}`) return c.text("unauthorized", 401); await next(); });
  app.get("/health", c => c.json({ ok: true, controlledFixture: true }));
  // This route is confined to the disposable fixture server, never production registration.
  app.post("/fixture/next-call-unknown", c => { nextGatewayUnknown = true; return c.json({ armed: true, transport: "gateway", controlledFixture: true }); });
  if (options.automaticPricingView) app.post("/fixture/pricing-sample", async c => {
    const sample = broker.wrapGateway(async function* () { yield { type: "done" as const, usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, cacheWriteTokens: 50 } }; });
    for await (const _ of sample({ providerType: "openai_compatible", baseUrl: "https://api.openai.com/v1", apiKey: "fixture-not-a-real-key", modelId: "gpt-5.6-luna", messages: [{ role: "user", content: "Controlled pricing sample" }],
      invocation: { roomId: work.id, rootTaskId: "pricing-examples", runId: "pricing-examples", agentId: "fixture-a", providerConnectionId: "pricing-openai", runProfileVersion: "fixture-v1", logicalStepId: "pricing-new-sample", purpose: "respond" } })) { /* Controlled stream only. */ }
    return c.json({ controlledFixture: true });
  });
  app.route("/config", configRoutes(config)); app.route("/providers", providerRoutes(db, secrets, controlledFetch)); app.route("/agents", agentRoutes(db));
  app.route("/sessions", sessionRoutes(sessions, events, usage, workspaces)); app.route("/workspaces", workspaceRoutes(workspaces));
  app.route("/room-commands", roomCommandRoutes(commands)); app.route("/multi", multiAgentRoutes(tasks, coordinator, execution, approvals, team, adaptive));
  const arena = new ArenaService(db,{sessions,workspaces,commands,verification,quotes,baseDirectory:join(directory,"arena"),controlled:true});
  arena.recover();
  app.route("/arena",arenaRoutes(arena));
  app.route("/arena-artifacts",arenaArtifactRoutes(new ArenaArtifactService(db,workspaces,leases)));
  app.route("/arena-strategy",arenaStrategyRoutes(new ArenaStrategyService(db,sessions,id=>arena.results(id))));
  const flightRecorder = new FlightRecorderService(db);
  const projectMemory = new ProjectMemoryService(db);
  app.route("/flight-recorder",flightRecorderRoutes(flightRecorder));
  app.route("/project-memory",projectMemoryRoutes(projectMemory));
  app.route("/verification",verificationRoutes(verification));
  app.route("/routing",routingRoutes(routes,adaptive));
  app.route("/agent", agentRunRoutes(supervisor, runner, approvals, executionEvents,(child,key)=>adaptive.notifyChildProgress(child,key).then(()=>{}))); app.route("/cost", costRoutes(db, sessions, broker, quotes, costTasks, commands));
  app.route("/content", contentRoutes(db, workspaces, attachments));
  app.get("/rooms", c => c.json([])); app.get("/mcp/servers", c => c.json([]));
  return { directory, db, arena, flightRecorder, projectMemory, routes, adaptive, sessions, workspaces, workspace, roomIds: { work: work.id, chat: chat.id }, broker, commands, quotes, costTasks, tasks, coordinator, verification, packages,
    execution, team, runtimes, approvals, runner, supervisor, app, token, headers, gatewayCalls, nativeCalls,
    async close() { await arena.shutdown(); await adaptive.shutdown(); await verification.shutdown(); await commands.shutdown(); await team.shutdown(); await execution.shutdown(); await supervisor.shutdown(); await flightRecorder.shutdown(); db.close(); rmSync(directory, { recursive: true, force: true }); } };
}
