import { Hono } from "hono";
import { cors } from "hono/cors";
import { HANDSHAKE_PROTOCOL, serializeHandshake } from "@socrates/core";

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

app.get("/health", (c) => c.json({ ok: true }));

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: app.fetch,
});
if (server.port === undefined) throw new Error("TCP server has no port");

console.log(serializeHandshake({ protocol: HANDSHAKE_PROTOCOL, port: server.port, token }));
