import { Hono } from "hono";
import { cors } from "hono/cors";
import { HANDSHAKE_PROTOCOL, serializeHandshake } from "@socrates/core";
import { defaultDataDir, defaultDbPath, openDb } from "./db";
import { KeychainSecrets } from "./secrets";
import { providerRoutes } from "./providers";
import { agentRoutes } from "./agents";
import { roomRoutes } from "./rooms";
import { createAiSdkModel, makeAiSdkGateway } from "./gateway-aisdk";
import { ConfigStore, configRoutes } from "./config-store";
import { makeProxiedFetch } from "./net";
import { WorkspaceManager } from "./workspace/manager";
import { workspaceRoutes } from "./routes/workspaces";
import { SessionStore } from "./store/session-store";
import { EventStore } from "./store/event-store";
import { sessionRoutes } from "./routes/sessions";
import { isAllowedLoopbackHost, isAllowedRendererOrigin } from "./security/loopback";
import { ApprovalManager } from "./approvals/manager";
import { RuntimeManager } from "./runtime/runtime-manager";
import { SingleAgentRunner } from "./runtime/single-agent-runner";
import { agentRunRoutes } from "./routes/agent-runs";
import { AttachmentResolver } from "./attachments/resolver";
import { contentRoutes } from "./routes/content";
import { WorkspacePathPolicy } from "./workspace/path-policy";
import { createHash } from "node:crypto";
import { streamText, tool, jsonSchema } from "ai";
import { LangGraphAgentRuntime } from "./runtime/langgraph-agent-runtime";
import { createReadOnlyBuiltins } from "./tools/read-only-builtins";
import { ToolRegistry } from "./tools/registry";
import { ToolExecutor } from "./tools/executor";
import type { ProviderType } from "@socrates/core";
import { McpStore } from "./mcp/store";
import { McpManager } from "./mcp/manager";
import { OfficialMcpClientAdapter } from "./mcp/adapter";
import { mcpRoutes } from "./routes/mcp";
import { MultiTaskStore } from "./multi-agent/task-store";
import { MultiAgentCoordinator } from "./multi-agent/coordinator";
import { ExecutionRunner } from "./runtime/execution-runner";
import { WorkspaceLeaseManager } from "./workspace/leases";
import { multiAgentRoutes } from "./routes/multi-agent";
import type { OrchestrationAgent } from "@socrates/core";
import { UsageCollector } from "./services/usage-collector";

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
const secrets = new KeychainSecrets();
const config = new ConfigStore(undefined, secrets);
// 所有出站请求（连接测试/列模型/模型调用）都按 config.toml 的代理设置走
const proxiedFetch = makeProxiedFetch(() => config.getResolved());
const gateway = makeAiSdkGateway(proxiedFetch);
const workspaces = new WorkspaceManager(db);
const sessions = new SessionStore(db);
const events = new EventStore(db);
const approvals = new ApprovalManager(db);
const attachments = new AttachmentResolver(db, defaultDataDir());
const mcpStore = new McpStore(db, secrets);
const mcp = new McpManager(db, mcpStore, new OfficialMcpClientAdapter(proxiedFetch));
const runtimes = new RuntimeManager(db, events);
runtimes.register("native_ai_sdk", (input) => {
  const workspace = input.workspaceId ? workspaces.get(input.workspaceId) : null;
  if (!workspace) throw new Error("native_workspace_required");
  const agent = db.query<{
    provider_id: string; model_id: string; system_prompt: string; role: string;
  }, [string]>("SELECT provider_id, model_id, system_prompt, role FROM agents WHERE id = ?").get(input.agentId);
  if (!agent) throw new Error("native_agent_not_found");
  const provider = db.query<{
    type: ProviderType; base_url: string; api_key_ref: string; enabled: number;
  }, [string]>("SELECT type, base_url, api_key_ref, enabled FROM providers WHERE id = ?").get(agent.provider_id);
  if (!provider || provider.enabled !== 1) throw new Error("native_provider_unavailable");
  const apiKey = secrets.get(provider.api_key_ref);
  if (!apiKey) throw new Error("native_provider_key_missing");
  const policy = new WorkspacePathPolicy(workspace.canonicalPath);
  const mcpDefinitions = mcp.definitionsFor(workspace.id, { effects: ["allow", "ask"] });
  const mcpEffects = new Map(mcp.policyEntriesFor(workspace.id).map((entry) => [entry.namespacedName, entry.effect]));
  const registry = new ToolRegistry([...createReadOnlyBuiltins(policy), ...mcpDefinitions]);
  const executor = new ToolExecutor(db, registry, approvals);
  const model = createAiSdkModel({
    providerType: provider.type,
    baseUrl: provider.base_url,
    apiKey,
    modelId: agent.model_id,
    fetchImpl: proxiedFetch,
  });
  const availableDefs = registry.available({ mode: "single_agent", phase: "executing", allowedCapabilities: ["workspace_read", "mcp"] });
  return new LangGraphAgentRuntime({
    sessionId: input.sessionId,
    agentId: input.agentId,
    workspaceId: workspace.id,
    system: [agent.role, agent.system_prompt].filter(Boolean).join("\n\n"),
    modelInvoker: async function* (invokeInput) {
      const tools: Record<string, any> = Object.fromEntries(
        availableDefs.map((def) => [def.name, tool({ description: def.description, inputSchema: jsonSchema(def.inputSchema) })])
      );
      const result = streamText({
        model,
        system: invokeInput.system,
        messages: invokeInput.messages.map((m: any) => ({
          role: m.getType?.() === "human" ? "user" : m.getType?.() === "ai" ? "assistant" : m.getType?.() === "tool" ? "tool" : "user",
          content: m.content,
          ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        })),
        tools: Object.keys(tools).length > 0 ? tools : undefined,
        maxRetries: 2,
        abortSignal: invokeInput.signal,
      });
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") yield { type: "text_delta" as const, text: part.text };
        else if (part.type === "tool-call") yield { type: "tool_call" as const, callId: part.toolCallId, name: part.toolName, input: part.input };
        else if (part.type === "finish") yield { type: "usage" as const, usage: { inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null, cost: null, currency: null, source: "provider" as const, estimated: false, effort: null } };
        else if (part.type === "error") throw part.error;
        else if (part.type === "abort") throw new Error(part.reason ?? "cancelled");
      }
    },
    toolExecutor: async ({ callId, name, input: toolInput, signal }) => {
      const context = {
        callId, sessionId: input.sessionId, taskId: input.agentSessionId, turnId: input.agentSessionId,
        agentId: input.agentId, workspaceId: workspace.id, mode: "single_agent" as const, phase: "executing" as const,
        signal: signal ?? new AbortController().signal,
      };
      const record = await executor.invoke({
        stableKey: `${input.agentSessionId}:${callId}`, name, generation: 1, input: toolInput,
        workspaceIdentity: workspace.identityHash, policyVersion: 1, attemptId: input.agentSessionId,
      }, context, {
        effect: "allow", risk: availableDefs.find(d => d.name === name)?.risk ?? "medium",
        matchedRuleIds: ["native-read-only"], reasonCode: "native_read_only_tool",
        freshHumanRequired: false, policyVersion: 1,
      });
      if (record.status === "succeeded" && record.output) return { output: record.output, isError: false };
      return { output: record.error ?? "tool_failed", isError: true };
    },
    toolNeedsApproval: (toolName) => {
      const def = availableDefs.find(d => d.name === toolName);
      return def ? (def.risk === "high" || def.risk === "destructive") : true;
    },
  });
});
const agentRuns = new SingleAgentRunner(db, runtimes, approvals, events, attachments);
runtimes.recoverInterrupted();
agentRuns.recoverInterrupted();
const multiTasks = new MultiTaskStore(db);
const usage = new UsageCollector(db);
const resolveMultiAgent = (agentId: string, snapshot: Record<string, unknown>): OrchestrationAgent => {
  const providerId = String(snapshot.providerId ?? "");
  const provider = db.query<{ type: ProviderType; base_url: string; api_key_ref: string; enabled: number }, [string]>("SELECT type, base_url, api_key_ref, enabled FROM providers WHERE id = ?").get(providerId);
  if (!provider || provider.enabled !== 1) throw new Error("multi_provider_unavailable");
  const apiKey = secrets.get(provider.api_key_ref);
  if (!apiKey) throw new Error("multi_provider_key_missing");
  return {
    id: agentId, nickname: String(snapshot.nickname ?? agentId), avatar: typeof snapshot.avatar === "string" ? snapshot.avatar : undefined,
    modelId: String(snapshot.modelId ?? ""), role: String(snapshot.role ?? ""), systemPrompt: String(snapshot.systemPrompt ?? ""),
    temperature: typeof snapshot.temperature === "number" ? snapshot.temperature : undefined,
    reasoningEffort: typeof snapshot.reasoningEffort === "string" ? snapshot.reasoningEffort as OrchestrationAgent["reasoningEffort"] : undefined,
    providerType: provider.type, baseUrl: provider.base_url, apiKey,
  };
};
const multiCoordinator = new MultiAgentCoordinator(db, multiTasks, events, gateway, resolveMultiAgent);
const executionRunner = new ExecutionRunner(db, multiTasks, runtimes, new WorkspaceLeaseManager(db, crypto.randomUUID()), approvals, events);
multiTasks.recoverInterrupted();

app.get("/health", (c) => c.json({ ok: true }));
app.route("/config", configRoutes(config));
app.route("/providers", providerRoutes(db, secrets, proxiedFetch));
app.route("/agents", agentRoutes(db));
app.route("/rooms", roomRoutes(db, secrets, gateway, usage));
app.route("/workspaces", workspaceRoutes(workspaces));
app.route("/sessions", sessionRoutes(sessions, events, usage));
app.route("/agent", agentRunRoutes(agentRuns, approvals));
app.route("/content", contentRoutes(db, workspaces, attachments));
app.route("/mcp", mcpRoutes(mcpStore, mcp));
app.route("/multi", multiAgentRoutes(multiTasks, multiCoordinator, executionRunner, approvals));

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  // 推理模型的 turn 间隔可远超默认 10s 空闲超时；连接生命周期由任务流自己管理
  idleTimeout: 0,
  fetch: app.fetch,
});
if (server.port === undefined) throw new Error("TCP server has no port");

stopManagedServices = async () => {
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
