import { Hono } from "hono";
import { cors } from "hono/cors";
import { HANDSHAKE_PROTOCOL, serializeHandshake } from "@socrates/core";
import { defaultDbPath, openDb } from "./db";
import { KeychainSecrets } from "./secrets";
import { providerRoutes } from "./providers";
import { agentRoutes } from "./agents";
import { roomRoutes } from "./rooms";
import { makeAiSdkGateway } from "./gateway-aisdk";
import { ConfigStore, configRoutes } from "./config-store";
import { makeProxiedFetch } from "./net";

// 父进程（Tauri）异常退出（如 SIGKILL/SIGTERM 未走优雅关闭）时自动退出，避免孤儿进程占着端口
setInterval(() => {
  if (process.ppid === 1) process.exit(0);
}, 2000);

const token = crypto.randomUUID();
const app = new Hono();

// token 才是鉴权边界，origin 放开（服务只绑 127.0.0.1）
app.use("*", cors());
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

app.get("/health", (c) => c.json({ ok: true }));
app.route("/config", configRoutes(config));
app.route("/providers", providerRoutes(db, secrets, proxiedFetch));
app.route("/agents", agentRoutes(db));
app.route("/rooms", roomRoutes(db, secrets, makeAiSdkGateway(proxiedFetch)));

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  // 推理模型的 turn 间隔可远超默认 10s 空闲超时；连接生命周期由任务流自己管理
  idleTimeout: 0,
  fetch: app.fetch,
});
if (server.port === undefined) throw new Error("TCP server has no port");

console.log(serializeHandshake({ protocol: HANDSHAKE_PROTOCOL, port: server.port, token }));
