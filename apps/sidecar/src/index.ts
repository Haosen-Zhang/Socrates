import { WorkInteractionService } from "./services/work-interactions";
import { InboxService } from "./services/inbox";
import { interactionRoutes, inboxRoutes } from "./routes/work-interactions";
import { AgentLifecycleService } from "./services/agent-lifecycle";
import { agentLifecycleRoutes } from "./routes/agent-lifecycle";
import { WorkItemLaunchService } from "./services/work-item-launch";
import { workItemRoutes } from "./routes/work-items";
import { WorkItemService } from "./services/work-items";
import { squadRoutes } from "./routes/squads";
import { SquadService } from "./services/squads";
import { ArenaArtifactService } from "./services/arena-artifacts";
import { arenaArtifactRoutes } from "./routes/arena-artifacts";
import { ArenaStrategyService } from "./services/arena-strategy";
import { arenaStrategyRoutes } from "./routes/arena-strategy";
import { ArenaService } from "./services/arena-service";
import { arenaRoutes } from "./routes/arena";
import { FlightRecorderService } from "./services/flight-recorder";
import { flightRecorderRoutes } from "./routes/flight-recorder";
import { ProjectMemoryService } from "./services/project-memory";
import { projectMemoryRoutes } from "./routes/project-memory";
import { adaptiveEvidenceContext } from "./services/adaptive-context";
import { Hono } from "hono";
import { VerificationService } from "./services/verification-service";
import { taskVerificationTarget } from "./services/work-verification";
import { verificationRoutes } from "./routes/verification";
import { cors } from "hono/cors";
import { evaluatePermission, HANDSHAKE_PROTOCOL, serializeHandshake } from "@socrates/core";
import { defaultDataDir, defaultDbPath, openDb } from "./db";
import { KeychainSecrets } from "./secrets";
import { providerRoutes } from "./providers";
import { agentRoutes } from "./agents";
import { toAgent, type AgentRow } from "./agents";
import { resolveRunProfile, resolveSessionRunProfile, type RunProfile } from "./services/run-profile";
import { RoomCommandService } from "./services/room-command-service";
import { resolveRoomFileContext } from "./services/room-file-context";
import { roomCommandRoutes } from "./routes/room-commands";
import { roomRoutes } from "./rooms";
import { createAiSdkModel, makeAiSdkGateway } from "./gateway-aisdk";
import { ConfigStore, configRoutes } from "./config-store";
import { makeProxiedFetch } from "./net";
import { WorkspaceManager } from "./workspace/manager";
import { workspaceRoutes } from "./routes/workspaces";
import { SessionStore } from "./store/session-store";
import { EventStore } from "./store/event-store";
import { ExecutionEventStore } from "./store/execution-event-store";
import { sessionRoutes } from "./routes/sessions";
import { isAllowedLoopbackHost, isAllowedRendererOrigin } from "./security/loopback";
import { ApprovalManager } from "./approvals/manager";
import { RuntimeManager } from "./runtime/runtime-manager";
import { SingleAgentRunner } from "./runtime/single-agent-runner";
import { RunSupervisor } from "./runtime/run-supervisor";
import { agentRunRoutes } from "./routes/agent-runs";
import { AttachmentResolver } from "./attachments/resolver";
import { contentRoutes } from "./routes/content";
import { WorkspacePathPolicy } from "./workspace/path-policy";
import { NativeAgentRuntime, createAiSdkNativeStream } from "./runtime/native-agent-runtime";
import { createNativeBuiltinTools } from "./tools/native-builtins";
import { ToolOutputStore } from "./tools/output-store";
import { ToolRegistry } from "./tools/registry";
import { ToolExecutor } from "./tools/executor";
import type { PermissionAction, ProviderType, ToolCapability, ToolDefinition } from "@socrates/core";
import { McpStore } from "./mcp/store";
import { McpManager } from "./mcp/manager";
import { OfficialMcpClientAdapter } from "./mcp/adapter";
import { mcpRoutes } from "./routes/mcp";
import { MultiTaskStore } from "./multi-agent/task-store";
import { MultiAgentCoordinator } from "./multi-agent/coordinator";
import { WorkPackageStore } from "./multi-agent/work-package-store";
import { TeamRunner } from "./multi-agent/team-runner";
import { ExecutionRunner } from "./runtime/execution-runner";
import { WorkspaceLeaseManager } from "./workspace/leases";
import { multiAgentRoutes } from "./routes/multi-agent";
import type { OrchestrationAgent } from "@socrates/core";
import { UsageCollector } from "./services/usage-collector";
import { ModelCatalog } from "./model-catalog";
import { HistoryStore } from "./store/history-store";
import { join } from "node:path";
import { ModelInvocationBroker } from "./services/model-invocation-broker";
import { TaskQuoteService } from "./services/task-quotes";
import { costRoutes } from "./routes/cost";
import { CostTaskService } from "./services/cost-task-service";
import { RoutePolicyService } from "./services/route-policy";
import { AdaptiveWorkflowService } from "./services/adaptive-workflow";
import { createAdaptiveHosts } from "./services/adaptive-hosts";
import { routingRoutes } from "./routes/routing";

// 父进程（Tauri）异常退出（如 SIGKILL/SIGTERM 未走优雅关闭）时自动退出，避免孤儿进程占着端口
let stopManagedServices: () => Promise<void> = async () => {};
setInterval(() => {
  if (process.ppid === 1) void stopManagedServices().finally(() => process.exit(0));
}, 2000);

const token = crypto.randomUUID();
const app = new Hono();

app.use("*", async (c, next) => {
  if (!isAllowedLoopbackHost(c.req.header("host")) || !isAllowedRendererOrigin(c.req.header("origin"))) {
    return c.text("forbidden", 403);
  }
  await next();
});
app.use("*", cors({
  origin: (origin) => isAllowedRendererOrigin(origin) ? origin : "",
  allowHeaders: ["Authorization", "Content-Type"],
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
}));
app.use("*", async (c, next) => {
  if (c.req.header("authorization") !== `Bearer ${token}`) {
    return c.text("unauthorized", 401);
  }
  await next();
});

const db = openDb(defaultDbPath());
const history = new HistoryStore(db, join(defaultDataDir(), "history"));
const secrets = new KeychainSecrets();
const config = new ConfigStore(undefined, secrets);
// 所有出站请求（连接测试/列模型/模型调用）都按 config.toml 的代理设置走
const proxiedFetch = makeProxiedFetch(() => config.getResolved());
const modelCatalog = new ModelCatalog(defaultDataDir(), proxiedFetch);
const invocationBroker = new ModelInvocationBroker(db, id => {
  const provider = db.query<{ api_key_ref: string }, [string]>("SELECT api_key_ref FROM providers WHERE id=?").get(id);
  if (!provider || !secrets.get(provider.api_key_ref)) throw new Error("invocation_credentials_unavailable");
});
invocationBroker.budgets.recoverInterrupted();
const gateway = invocationBroker.wrapGateway(makeAiSdkGateway(proxiedFetch));
const workspaces = new WorkspaceManager(db);
const sessions = new SessionStore(db, history);
const events = new EventStore(db);
const executionEvents = new ExecutionEventStore(db);
const approvals = new ApprovalManager(db);
const toolOutputs = new ToolOutputStore(db);
const attachments = new AttachmentResolver(db, defaultDataDir());
const mcpStore = new McpStore(db, secrets);
const mcp = new McpManager(db, mcpStore, new OfficialMcpClientAdapter(proxiedFetch));
const runtimes = new RuntimeManager(db, executionEvents);
const leases = new WorkspaceLeaseManager(db, crypto.randomUUID());
runtimes.register("native_ai_sdk", (input) => {
  const session = sessions.get(input.sessionId);
  if (!session) throw new Error("native_session_not_found");
  const workspace = input.workspaceId ? workspaces.get(input.workspaceId) : null;
  if (session.kind === "chat" && input.workspaceId) throw new Error("chat_room_must_not_bind_workspace");
  if (session.kind === "cowork" && !workspace) throw new Error("native_workspace_required");
  const profile = (input.runtimeOptions?.runProfile as RunProfile | undefined)
    ?? resolveSessionRunProfile(db, input.sessionId, input.agentId);
  if (profile.agentId !== input.agentId) throw new Error("run_profile_member_mismatch");
  if (session.kind === "cowork" && profile.modelCapabilities.toolCalling === false) throw new Error("native_model_tools_unsupported");
  const provider = db.query<{
    type: ProviderType; base_url: string; api_key_ref: string; enabled: number;
  }, [string]>("SELECT type, base_url, api_key_ref, enabled FROM providers WHERE id = ?").get(profile.providerId);
  if (!provider || provider.enabled !== 1) throw new Error("native_provider_unavailable");
  const apiKey = secrets.get(provider.api_key_ref);
  if (!apiKey) throw new Error("native_provider_key_missing");
  const mcpDefinitions = workspace && session.kind === "cowork" ? mcp.definitionsFor(workspace.id, { effects: ["allow", "ask"] }) : [];
  const builtinTools = workspace && session.kind === "cowork" ? createNativeBuiltinTools(new WorkspacePathPolicy(workspace.canonicalPath), toolOutputs, {
    sessionId: input.sessionId, workspaceIdentity: workspace.identityHash,
  }) : [];
  const registry = new ToolRegistry([...builtinTools, ...mcpDefinitions]);
  const executor = new ToolExecutor(db, registry, approvals, undefined, executionEvents);
  const model = createAiSdkModel({
    providerType: provider.type,
    baseUrl: provider.base_url,
    apiKey,
    modelId: profile.modelId,
    fetchImpl: proxiedFetch,
  });
  const allowedCapabilities: ToolCapability[] = session.kind === "chat" ? [] : ["workspace_read", "workspace_write", "shell", "mcp"];
  if (!sessions.get(input.sessionId)) throw new Error("native_session_not_found");
  const actionFor = (definition: ToolDefinition): PermissionAction => {
    if (definition.name === "run_shell" || definition.capability === "shell") return "shell.execute";
    if (definition.capability === "workspace_read") return "workspace.read";
    if (definition.capability === "workspace_write") return "workspace.write";
    if (definition.capability === "network") return "network.request";
    return "mcp.invoke";
  };

  return new NativeAgentRuntime({
    sessionId: input.sessionId,
    taskId: input.agentSessionId,
    agentId: input.agentId,
    workspaceId: workspace?.id ?? "",
    workspaceIdentity: workspace?.identityHash ?? `chat:${session.id}`,
    system: [profile.role, profile.systemPrompt,adaptiveEvidenceContext(input.runtimeOptions?.adaptiveHandoff)].filter(Boolean).join("\n\n"),
    registry,
    executor,
    stream: createAiSdkNativeStream(model, undefined, { providerType: provider.type, modelId: profile.modelId, baseUrl: provider.base_url,
      temperature: profile.temperature, reasoningEffort: profile.reasoningEffort, broker: invocationBroker,
      invocation: { roomId: input.sessionId, rootTaskId: String(input.runtimeOptions?.costRootTaskId ?? input.agentSessionId),
        runId: String(input.runtimeOptions?.costRunId ?? input.agentSessionId), agentId: input.agentId,
        providerConnectionId: profile.providerId, runProfileVersion: profile.configurationVersion,
        logicalStepId: input.agentSessionId, purpose: session.kind === "chat" ? "respond" : "execute",
        ...(typeof input.runtimeOptions?.costRouteAttemptId === "string" ? { routeAttemptId: input.runtimeOptions.costRouteAttemptId } : {}),
        ...(typeof input.runtimeOptions?.costWorkPackageId === "string" ? { workPackageId: input.runtimeOptions.costWorkPackageId } : {}),
        contextWindowTokens: profile.contextWindowTokens,
        ...(profile.modelCapabilities.contextWindow?.catalogValue && profile.modelCapabilities.contextWindow.catalogProviderId && profile.modelCapabilities.contextWindow.catalogRevision
          ? { catalogContextWindow: { tokens: profile.modelCapabilities.contextWindow.catalogValue, providerId: profile.modelCapabilities.contextWindow.catalogProviderId,
            revision: profile.modelCapabilities.contextWindow.catalogRevision } } : {}) } }),
    allowedCapabilities,
    permissionForTool: (definition) => {
      const currentSession = sessions.get(input.sessionId);
      if (!currentSession) throw new Error("native_session_not_found");
      const costBudget = invocationBroker.budgets.get(String(input.runtimeOptions?.costRootTaskId ?? input.agentSessionId));
      if (definition.capability === "mcp" && costBudget && costBudget.mode !== "tracking_only") {
        // No external tool has a verified monetary tariff yet. With a task
        // budget it must never silently escape the coverage shown in the quote.
        return { effect: "deny", reasonCode: "cost_budget_unpriced_external_tool", policyVersion: currentSession.approvalPolicy.version,
          freshHumanRequired: false, risk: definition.risk, matchedRuleIds: [] };
      }
      return evaluatePermission({
        action: actionFor(definition),
        resource: definition.name,
        risk: definition.risk,
        mode: session.kind === "chat" ? "chat" : "single_agent",
        phase: "executing",
        capabilityAllowed: allowedCapabilities.includes(definition.capability),
        policyVersion: currentSession.approvalPolicy.version,
        approvalMode: currentSession.approvalPolicy.mode,
        rules: [],
      });
    },
  });
});
let adaptive: AdaptiveWorkflowService;
const routing = new RoutePolicyService(db,sessions,{hasCredentials:(_id,ref)=>{try{return Boolean(secrets.get(ref));}catch{return false;}}});
const verification = new VerificationService(db,sessions,workspaces,leases,approvals,events,executionEvents,toolOutputs,{
  onChanged:view=>{void adaptive?.notifyVerificationProgress(view.target.rootTaskId,`verification:${view.run?.id ?? view.plan?.id}:${view.verificationStatus}:${view.outcome}`).catch(()=>{});},
});
verification.recoverInterrupted();
const agentRuns = new SingleAgentRunner(db, runtimes, approvals, executionEvents, attachments, history, leases, verification);
const runSupervisor = new RunSupervisor(agentRuns);
const multiTasks = new MultiTaskStore(db, history);
await history.bootstrapAll();
runtimes.recoverInterrupted();
runSupervisor.recoverInterrupted();
const usage = new UsageCollector(db);
const resolveMultiAgent = (agentId: string, snapshot: Record<string, unknown>): OrchestrationAgent => {
  const profile = resolveRunProfile(agentId, snapshot);
  const providerId = profile.providerId;
  const provider = db.query<{ type: ProviderType; base_url: string; api_key_ref: string; enabled: number }, [string]>("SELECT type, base_url, api_key_ref, enabled FROM providers WHERE id = ?").get(providerId);
  if (!provider || provider.enabled !== 1) throw new Error("multi_provider_unavailable");
  const apiKey = secrets.get(provider.api_key_ref);
  if (!apiKey) throw new Error("multi_provider_key_missing");
  return {
    id: agentId, nickname: String(snapshot.nickname ?? agentId), avatar: typeof snapshot.avatar === "string" ? snapshot.avatar : undefined,
    modelId: profile.modelId, role: profile.role, systemPrompt: profile.systemPrompt,
    temperature: profile.temperature,
    reasoningEffort: profile.reasoningEffort,
    contextWindowTokens: profile.contextWindowTokens,
    providerType: provider.type, baseUrl: provider.base_url, apiKey,
    providerConnectionId: profile.providerId, runProfileVersion: profile.configurationVersion,
    ...(profile.modelCapabilities.contextWindow?.catalogValue && profile.modelCapabilities.contextWindow.catalogProviderId && profile.modelCapabilities.contextWindow.catalogRevision
      ? { catalogContextWindow: { tokens: profile.modelCapabilities.contextWindow.catalogValue, providerId: profile.modelCapabilities.contextWindow.catalogProviderId,
        revision: profile.modelCapabilities.contextWindow.catalogRevision } } : {}),
  };
};
const multiCoordinator = new MultiAgentCoordinator(db, multiTasks, events, gateway, resolveMultiAgent, history,verification);
const executionRunner = new ExecutionRunner(db, multiTasks, runtimes, leases, approvals, events, executionEvents, history, verification);
multiTasks.recoverInterrupted();
const workPackages = new WorkPackageStore(db,item=>verification.view(taskVerificationTarget(db,item.taskId,item.id)).gatePassed);
workPackages.recoverInterrupted();
const teamRunner = new TeamRunner(db, multiTasks, workPackages, executionRunner, multiCoordinator, events, history, verification);
executionRunner.reconcileDurableTurnEvents();
adaptive = new AdaptiveWorkflowService(db,routing,verification,createAdaptiveHosts(db,routing,sessions,runSupervisor,agentRuns,multiTasks,multiCoordinator,teamRunner,verification,input=>{
  const room=sessions.get(input.roomId)!;
  const refs=[...new Set([...(input.workspaceRefIds??[]),...input.mentions.flatMap(mention=>mention.type==="file"?[mention.refId]:[])])];
  return refs.length||input.attachmentIds?.length?resolveRoomFileContext(db,workspaces,attachments,room.workspaceId,refs,input.attachmentIds??[]).text:"";
}),{onChanged:view=>{
  const status=["completed","failed","cancelled"].includes(view.status)?view.status:view.status==="blocked"?"failed":["pending","running","assessing"].includes(view.status)?"running":"interrupted";
  db.query("UPDATE sessions SET status=?,updated_at=? WHERE id=?").run(status,new Date().toISOString(),view.roomId);
}});
adaptive.recoverInterrupted();
const commands = new RoomCommandService(db, sessions, {
  startDirect: (input) => runSupervisor.start(input),
  getDirect: (id) => runSupervisor.get(id),
  cancelDirect: (id) => runSupervisor.cancel(id),
  isTeamActive: (id) => teamRunner.isActive(id),
  cancelTeam:async id=>{multiCoordinator.cancel(id);await multiCoordinator.wait(id);await teamRunner.cancel(id);},
  resolveFileContext: (workspaceId, refs, ids) => resolveRoomFileContext(db, workspaces, attachments, workspaceId, refs, ids),
  createTeam: async ({ sessionId, prompt, clientRequestId, targetAgentIds, inputContext }) => {
    const room = sessions.get(sessionId)!;
    const task = await multiCoordinator.create({ sessionId, prompt, config: {
      speakingOrder: room.collaboration.discussion.speakerOrder.length ? room.collaboration.discussion.speakerOrder : room.agents.map((a) => a.agentId),
      maxRounds: room.collaboration.discussion.maxRounds,
      synthesizerId: room.collaboration.assignment.coordinatorAgentId ?? room.primaryAgentId,
      executionAgentId: room.primaryAgentId,
      teamExecution: true, clientRequestId, targetAgentIds, inputContext,
    } });
    void multiCoordinator.run(task.id).catch(() => {});
    return { taskId: task.id };
  },
  resolveAgent: resolveMultiAgent, gateway, verification, routing, adaptive,
}, history);
commands.recoverInterrupted();
const costTasks = new CostTaskService(db, commands, runSupervisor, agentRuns, multiTasks, multiCoordinator, teamRunner, executionRunner,{routing,adaptive});

const agentLifecycle=new AgentLifecycleService(db,{secrets,runtimeReady:()=>runtimes.isRegistered("native_ai_sdk")});
const workItems=new WorkItemService(db,commands,verification);
 const squads=new SquadService(db,sessions,workspaceId=>workItems.list(workspaceId),agentLifecycle);
 const workItemLaunch=new WorkItemLaunchService(db,workItems,sessions,squads,new TaskQuoteService(db,sessions,routing),commands);
 const inbox=new InboxService(db,workItems,commands,verification);
 const interactions=new WorkInteractionService(db,workItems,sessions,commands,multiCoordinator,multiTasks,teamRunner,workPackages,()=>{inbox.list();});
 interactions.start(500);
 app.get("/health", (c) => c.json({ ok: true }));
app.route("/config", configRoutes(config));
app.route("/providers", providerRoutes(db, secrets, proxiedFetch));
app.route("/agents", agentRoutes(db, modelCatalog));
app.route("/agent-lifecycle", agentLifecycleRoutes(agentLifecycle));
  app.route("/squads", squadRoutes(squads));
app.route("/rooms", roomRoutes(db, secrets, gateway, usage, sessions));
app.route("/workspaces", workspaceRoutes(workspaces));
app.route(
  "/sessions",
  sessionRoutes(sessions, events, usage, workspaces, () => config.get().collaborationDefaults, (agentId) => {
    const row = db.query<AgentRow, [string]>("SELECT * FROM agents WHERE id = ?").get(agentId);
    if (!row) throw new Error("agent_template_not_found");
    return { ...toAgent(row), configurationVersion: row.updated_at };
  }, (snapshot) => {
    const provider = db.query<{ enabled: number; api_key_ref: string }, [string]>("SELECT enabled,api_key_ref FROM providers WHERE id = ?").get(String(snapshot.providerId ?? ""));
    if (!provider) return "provider_deleted";
    if (!provider.enabled) return "provider_disabled";
    try { return secrets.get(provider.api_key_ref) ? null : "multi_provider_key_missing"; }
    catch { return "multi_provider_key_missing"; }
  }),
);
app.route("/room-commands", roomCommandRoutes(commands));
const arena = new ArenaService(db,{sessions,workspaces,commands,verification,quotes:new TaskQuoteService(db,sessions,routing),baseDirectory:join(defaultDataDir(),"arena"),});
arena.recover();
app.route("/arena",arenaRoutes(arena));
app.route("/arena-artifacts",arenaArtifactRoutes(new ArenaArtifactService(db,workspaces,leases)));
app.route("/arena-strategy",arenaStrategyRoutes(new ArenaStrategyService(db,sessions,id=>arena.results(id))));
const flightRecorder = new FlightRecorderService(db);
const projectMemory = new ProjectMemoryService(db);
app.route("/flight-recorder",flightRecorderRoutes(flightRecorder,executionEvents));
app.route("/project-memory",projectMemoryRoutes(projectMemory));
app.route("/verification",verificationRoutes(verification));
app.route("/routing",routingRoutes(routing,adaptive));
app.route("/work-items",interactionRoutes(interactions,'item'));
  app.route("/room-commands/rooms",interactionRoutes(interactions,'room'));
  app.route("/inbox",inboxRoutes(inbox));
  app.route("/work-items", workItemRoutes(workItems,workItemLaunch));
app.route("/cost", costRoutes(db, sessions, invocationBroker, new TaskQuoteService(db, sessions,routing), costTasks, commands));
app.route("/agent", agentRunRoutes(runSupervisor, agentRuns, approvals, executionEvents, (child,key)=>adaptive.notifyChildProgress(child,key).then(()=>{})));
app.route("/content", contentRoutes(db, workspaces, attachments));
app.route("/mcp", mcpRoutes(mcpStore, mcp));
app.route("/multi", multiAgentRoutes(multiTasks, multiCoordinator, executionRunner, approvals, teamRunner, adaptive));

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  // 推理模型的 turn 间隔可远超默认 10s 空闲超时；连接生命周期由任务流自己管理
  idleTimeout: 0,
  fetch: app.fetch,
});
if (server.port === undefined) throw new Error("TCP server has no port");

stopManagedServices = async () => {
  await interactions.shutdown();
  await arena.shutdown();
  await adaptive.shutdown();
  await verification.shutdown();
  await commands.shutdown();
  await teamRunner.shutdown();
  await executionRunner.shutdown();
  await runSupervisor.shutdown();
  await flightRecorder.shutdown();
  await mcp.stopAll();
  server.stop(true);
};
for (const configured of mcpStore.listAll().filter((item) => item.enabled)) {
  void mcp.connect(configured.id).catch(() => {});
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void stopManagedServices().finally(() => process.exit(0)));
}

console.log(serializeHandshake({ protocol: HANDSHAKE_PROTOCOL, port: server.port, token }));
