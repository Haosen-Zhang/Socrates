import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  encodeSseEvent,
  historyToChatMessages,
  type ModelGateway,
  type ProviderType,
  type StoredMessage,
  type StreamEvent,
} from "@socrates/core";
import { toAgent, type AgentRow } from "./agents";
import type { SecretStore } from "./secrets";

type RoomRow = { id: string; name: string; created_at: string; updated_at: string };
type MessageRow = {
  id: string;
  room_id: string;
  role: "user" | "agent";
  agent_id: string | null;
  agent_name: string | null;
  model: string | null;
  content: string;
  created_at: string;
};
type ProviderRow = { id: string; type: ProviderType; base_url: string; api_key_ref: string };

function toMessage(r: MessageRow): StoredMessage {
  return {
    id: r.id,
    roomId: r.room_id,
    role: r.role,
    agentId: r.agent_id ?? undefined,
    agentName: r.agent_name ?? undefined,
    model: r.model ?? undefined,
    content: r.content,
    createdAt: r.created_at,
  };
}

export function roomRoutes(db: Database, secrets: SecretStore, gateway: ModelGateway) {
  const app = new Hono();
  const roomById = (id: string) => db.query<RoomRow, [string]>("SELECT * FROM rooms WHERE id = ?").get(id);
  const roomAgents = (roomId: string) =>
    db
      .query<AgentRow, [string]>(
        `SELECT a.* FROM agents a JOIN room_agents ra ON ra.agent_id = a.id
         WHERE ra.room_id = ? ORDER BY ra.position`,
      )
      .all(roomId);
  const roomMessages = (roomId: string) =>
    db.query<MessageRow, [string]>("SELECT * FROM messages WHERE room_id = ? ORDER BY created_at").all(roomId);

  const insertMessage = (m: Omit<StoredMessage, "id" | "createdAt">): StoredMessage => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO messages (id, room_id, role, agent_id, agent_name, model, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, m.roomId, m.role, m.agentId ?? null, m.agentName ?? null, m.model ?? null, m.content, now],
    );
    return { ...m, id, createdAt: now };
  };

  app.get("/", (c) => {
    const rows = db.query<RoomRow, []>("SELECT * FROM rooms ORDER BY created_at").all();
    return c.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        agentIds: roomAgents(r.id).map((a) => a.id),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    );
  });

  app.post("/", async (c) => {
    const b = await c.req.json<{ name: string; agentIds: string[] }>();
    if (!b.name?.trim()) return c.json({ error: "房间名不能为空" }, 400);
    if (!Array.isArray(b.agentIds) || b.agentIds.length === 0) {
      return c.json({ error: "至少邀请一个 Agent" }, 400);
    }
    for (const aid of b.agentIds) {
      if (!db.query("SELECT id FROM agents WHERE id = ?").get(aid)) {
        return c.json({ error: "存在无效的 Agent" }, 400);
      }
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO rooms (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", [id, b.name.trim(), now, now]);
    b.agentIds.forEach((aid, i) =>
      db.run("INSERT INTO room_agents (room_id, agent_id, position) VALUES (?, ?, ?)", [id, aid, i]),
    );
    return c.json({ id, name: b.name.trim(), agentIds: b.agentIds, createdAt: now, updatedAt: now }, 201);
  });

  app.delete("/:id", (c) => {
    const room = roomById(c.req.param("id"));
    if (!room) return c.json({ error: "房间不存在" }, 404);
    db.run("DELETE FROM messages WHERE room_id = ?", [room.id]);
    db.run("DELETE FROM room_agents WHERE room_id = ?", [room.id]);
    db.run("DELETE FROM rooms WHERE id = ?", [room.id]);
    return c.json({ ok: true });
  });

  app.get("/:id/messages", (c) => {
    const room = roomById(c.req.param("id"));
    if (!room) return c.json({ error: "房间不存在" }, 404);
    return c.json(roomMessages(room.id).map(toMessage));
  });

  // MVP-3：单 Agent 单轮 —— 取房间第一个 Agent 回复；MVP-4 换成编排循环
  app.post("/:id/messages", async (c) => {
    const room = roomById(c.req.param("id"));
    if (!room) return c.json({ error: "房间不存在" }, 404);
    const b = await c.req.json<{ content: string }>();
    if (!b.content?.trim()) return c.json({ error: "消息不能为空" }, 400);
    const agentRow = roomAgents(room.id)[0];
    if (!agentRow) return c.json({ error: "房间里没有 Agent" }, 400);
    const agent = toAgent(agentRow);
    const provider = db
      .query<ProviderRow, [string]>("SELECT id, type, base_url, api_key_ref FROM providers WHERE id = ?")
      .get(agent.providerId);
    if (!provider) return c.json({ error: `Agent「${agent.displayName}」引用的供应商已被删除` }, 400);
    const apiKey = secrets.get(provider.api_key_ref);
    if (!apiKey) return c.json({ error: "Keychain 中找不到该供应商的 API Key" }, 400);

    const userMessage = insertMessage({ roomId: room.id, role: "user", content: b.content.trim() });
    const history = roomMessages(room.id).map(toMessage);

    // 客户端断开（关窗/切页）不终止生成：回复仍要完整落库，只是不再写流
    let clientGone = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        clientGone = true;
      },
      async start(controller) {
        const emit = (e: StreamEvent) => {
          if (clientGone) return;
          try {
            controller.enqueue(new TextEncoder().encode(encodeSseEvent(e)));
          } catch {
            clientGone = true;
          }
        };
        emit({ type: "user_message", message: userMessage });
        emit({ type: "turn_started", agentId: agent.id, agentName: agent.displayName, model: agent.modelId });
        let text = "";
        let failed = false;
        try {
          for await (const ev of gateway({
            providerType: provider.type,
            baseUrl: provider.base_url,
            apiKey,
            modelId: agent.modelId,
            system: agent.systemPrompt || undefined,
            temperature: agent.temperature,
            messages: historyToChatMessages(history),
          })) {
            if (ev.type === "delta") {
              text += ev.text;
              emit({ type: "delta", text: ev.text });
            } else if (ev.type === "error") {
              failed = true;
              emit({ type: "error", message: ev.message });
            }
          }
        } catch (err) {
          failed = true;
          emit({ type: "error", message: String(err).slice(0, 300) });
        }
        if (!failed) {
          const saved = insertMessage({
            roomId: room.id,
            role: "agent",
            agentId: agent.id,
            agentName: agent.displayName,
            model: agent.modelId,
            content: text,
          });
          emit({ type: "message_completed", message: saved });
        }
        if (!clientGone) {
          try {
            controller.close();
          } catch {
            // 消费端已取消
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        // hono cors 中间件不会作用到这个手工 Response，补上跨源头
        "access-control-allow-origin": "*",
      },
    });
  });

  return app;
}
