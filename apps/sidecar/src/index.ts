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
import { CodexRuntime } from "./runtime/codex/codex-runtime";
import { configuredCodexBinary } from "./runtime/codex/binary";
import { createPinnedCodexClient } from "./runtime/codex/protocol-client";
import { agentRunRoutes } from "./routes/agent-runs";
import { AttachmentResolver } from "./attachments/resolver";
import { contentRoutes } from "./routes/content";
import { WorkspacePathPolicy } from "./workspace/path-policy";
import { createHash } from "node:crypto";
import { NativeAgentRuntime, createAiSdkNativeStream } from "./runtime/native-agent-runtime";
import { createReadOnlyBuiltins } from "./tools/read-only-builtins";
import { ToolRegistry } from "./tools/registry";
import { ToolExecutor } from "./tools/executor";
import type { ProviderType } from "@socrates/core";

// 父进程（Tauri）异常退出（如 SIGKILL/SIGTERM 未走优雅关闭）时自动退出，避免孤儿进程占着端口
setInterval(() => {
  if (process.ppid === 1) process.exit(0);
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
const config = new ConfigStore();
// 所有出站请求（连接测试/列模型/模型调用）都按 config.toml 的代理设置走
const proxiedFetch = makeProxiedFetch(() => config.get());
const workspaces = new WorkspaceManager(db);
const sessions = new SessionStore(db);
const events = new EventStore(db);
const approvals = new ApprovalManager(db);
const attachments = new AttachmentResolver(db, defaultDataDir());
const runtimes = new RuntimeManager(db, events);
runtimes.register("codex_app_server", (input) => {
  const workspace = input.workspaceId ? workspaces.get(input.workspaceId) : null;
  if (!workspace) throw new Error("codex_workspace_required");
  const sandbox = input.runtimeOptions?.sandbox === "workspace-write" ? "workspace-write" : "read-only";
  const model = typeof input.runtimeOptions?.model === "string" ? input.runtimeOptions.model : undefined;
  return new CodexRuntime({
    cwd: workspace.canonicalPath,
    sandbox,
    model,
    clientFactory: async (approvalHandler) => createPinnedCodexClient(configuredCodexBinary(), approvalHandler),
    resolveAttachment: (attachmentId) => {
      const attachment = attachments.read(attachmentId);
      return { mediaType: attachment.record.mediaType, filename: attachment.record.filename, bytes: attachment.bytes };
    },
    resolveWorkspaceRef: (relativePath, snapshotHash) => {
      const content = new WorkspacePathPolicy(workspace.canonicalPath).readText(relativePath, 512 * 1024);
      if (content.truncated) throw new Error("workspace_ref_context_too_large");
      const currentHash = createHash("sha256").update(content.text).digest("hex");
      if (snapshotHash && currentHash !== snapshotHash) throw new Error("workspace_ref_changed");
      return { text: content.text, currentHash };
    },
  });
});
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
  const registry = new ToolRegistry(createReadOnlyBuiltins(policy));
  const executor = new ToolExecutor(db, registry, approvals);
  const model = createAiSdkModel({
    providerType: provider.type,
    baseUrl: provider.base_url,
    apiKey,
    modelId: agent.model_id,
    fetchImpl: proxiedFetch,
  });
  return new NativeAgentRuntime({
    sessionId: input.sessionId,
    taskId: input.agentSessionId,
    agentId: input.agentId,
    workspaceId: workspace.id,
    workspaceIdentity: workspace.identityHash,
    system: [agent.role, agent.system_prompt].filter(Boolean).join("\n\n"),
    registry,
    executor,
    stream: createAiSdkNativeStream(model),
    resolveAttachment: (attachmentId) => {
      const attachment = attachments.read(attachmentId);
      return { mediaType: attachment.record.mediaType, filename: attachment.record.filename, bytes: attachment.bytes };
    },
    resolveWorkspaceRef: (relativePath, snapshotHash) => {
      const content = policy.readText(relativePath, 512 * 1024);
      if (content.truncated) throw new Error("workspace_ref_context_too_large");
      const currentHash = createHash("sha256").update(content.text).digest("hex");
      if (snapshotHash && currentHash !== snapshotHash) throw new Error("workspace_ref_changed");
      return { text: content.text };
    },
  });
});
const agentRuns = new SingleAgentRunner(db, runtimes, approvals, events, attachments);

app.get("/health", (c) => c.json({ ok: true }));
app.route("/config", configRoutes(config));
app.route("/providers", providerRoutes(db, secrets, proxiedFetch));
app.route("/agents", agentRoutes(db));
app.route("/rooms", roomRoutes(db, secrets, makeAiSdkGateway(proxiedFetch)));
app.route("/workspaces", workspaceRoutes(workspaces));
app.route("/sessions", sessionRoutes(sessions, events));
app.route("/agent", agentRunRoutes(agentRuns, approvals));
app.route("/content", contentRoutes(db, workspaces, attachments));

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  // 推理模型的 turn 间隔可远超默认 10s 空闲超时；连接生命周期由任务流自己管理
  idleTimeout: 0,
  fetch: app.fetch,
});
if (server.port === undefined) throw new Error("TCP server has no port");

console.log(serializeHandshake({ protocol: HANDSHAKE_PROTOCOL, port: server.port, token }));
